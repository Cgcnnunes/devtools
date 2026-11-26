import { applyQueryRule, restoreQueryRule, sameQueryRule, type QueryRule, type QueryUndo } from "../domain/query-rule.js";

export interface QueryTab {
  id: number;
  documentId: string;
  url: string;
}

export interface QueryRecord {
  ruleId: number;
  rule: QueryRule;
  tabId: number;
  documentId: string;
  undo: QueryUndo;
}

export interface QueryPort {
  tab(id: number): Promise<QueryTab | undefined>;
  replace(expected: QueryTab, url: string): Promise<boolean>;
  readUndo(): Promise<QueryRecord[]>;
  writeUndo(records: QueryRecord[]): Promise<void>;
}

export class QueryEngine {
  constructor(private readonly port: QueryPort) {}

  async forgetTab(tabId: number): Promise<void> {
    const records = await this.port.readUndo();
    await this.port.writeUndo(records.filter((record) => record.tabId !== tabId));
  }

  async apply(
    rule: QueryRule,
    tabId: number,
    approved?: { documentId: string; values: string[] },
  ): Promise<
    { kind: "applied" | "unchanged" } |
    { kind: "conflict"; values: string[]; tab: QueryTab } |
    { kind: "warning"; message: string }
  > {
    const tab = await this.port.tab(tabId);
    if (!tab) throw new Error("The tab is no longer available.");
    if (approved && tab.documentId !== approved.documentId) {
      throw new Error("The document changed since confirmation. Review the conflict again.");
    }
    let records = await this.port.readUndo();
    const old = records.filter((record) => record.ruleId === rule.id && record.tabId === tab.id);
    const prior = old.find((record) => record.documentId === tab.documentId);
    if (prior) {
      if (sameQueryRule(prior.rule, rule) && restoreQueryRule(prior.undo, tab.url).kind === "restored") {
        return { kind: "unchanged" };
      }
      return { kind: "warning", message: `The query parameter ${prior.undo.name} changed in tab ${tab.id}; it was preserved.` };
    }
    if (old.length) {
      records = records.filter((record) => !old.includes(record));
      await this.port.writeUndo(records);
    }
    const result = applyQueryRule(rule, tab.url, approved?.values);
    if (result.kind === "conflict") return { ...result, tab };
    if (result.kind !== "changed") return { kind: "unchanged" };
    const record = { ruleId: rule.id, rule, tabId: tab.id, documentId: tab.documentId, undo: result.undo };
    records.push(record);
    await this.port.writeUndo(records);
    if (!await this.port.replace(tab, result.url)) {
      await this.port.writeUndo(records.filter((item) => item !== record));
      throw new Error("The tab changed before the query rule could be applied.");
    }
    return { kind: "applied" };
  }

  async undo(ruleId: number): Promise<string[]> {
    let records = await this.port.readUndo();
    const warnings: string[] = [];
    for (const record of [...records]) {
      if (record.ruleId !== ruleId) continue;
      const tab = await this.port.tab(record.tabId);
      if (tab && tab.documentId === record.documentId) {
        const result = restoreQueryRule(record.undo, tab.url);
        if (result.kind === "changed-by-site" ||
            (result.kind === "restored" && !await this.port.replace(tab, result.url))) {
          warnings.push(`The query parameter ${record.undo.name} changed in tab ${record.tabId}; it was preserved.`);
          continue;
        }
      }
      records = records.filter((item) => item !== record);
      await this.port.writeUndo(records);
    }
    return warnings;
  }
}
