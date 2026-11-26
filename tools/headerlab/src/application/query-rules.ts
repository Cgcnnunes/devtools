import { addQueryRule, sameQueryRule, type QueryRule } from "../domain/query-rule.js";
import type { QueryEngine, QueryPort, QueryTab } from "./query-engine.js";

interface QueryConflict {
  ruleId: number;
  tab: QueryTab;
  values: string[];
}

interface IgnoredConflict {
  ruleId: number;
  tabId: number;
  documentId: string;
}

export interface QueryConflictState {
  pending: QueryConflict[];
  ignored: IgnoredConflict[];
}

export interface QueryRulesPort {
  read(): Promise<QueryRule[]>;
  write(rules: QueryRule[]): Promise<void>;
  active(): Promise<boolean>;
  permitted(rule: QueryRule): Promise<boolean>;
  tabs(rule: QueryRule): Promise<number[]>;
  tab: QueryPort["tab"];
  readConflicts(): Promise<QueryConflictState>;
  writeConflicts(state: QueryConflictState): Promise<void>;
  records: QueryPort["readUndo"];
  warn(messages: string[]): Promise<void>;
  apply: QueryEngine["apply"];
  undo: QueryEngine["undo"];
  forgetTab: QueryEngine["forgetTab"];
}

export class QueryRules {
  constructor(private readonly port: QueryRulesPort) {}

  async forgetTab(tabId: number): Promise<void> {
    await this.port.forgetTab(tabId);
    const state = await this.port.readConflicts();
    state.pending = state.pending.filter((item) => item.tab.id !== tabId);
    state.ignored = state.ignored.filter((item) => item.tabId !== tabId);
    await this.port.writeConflicts(state);
  }

  async reconcile(): Promise<string[]> {
    const rules = await this.port.read();
    const active = await this.port.active();
    const records = await this.port.records();
    const ids = new Set(records.filter((record) => {
      const rule = rules.find((item) => item.id === record.ruleId);
      return !active || !rule?.enabled || !sameQueryRule(rule, record.rule);
    }).map((record) => record.ruleId));
    const blocked = new Set<number>();
    const warnings: string[] = [];
    for (const id of ids) {
      await this.clearConflicts(id);
      const saved = records.find((record) => record.ruleId === id);
      if (saved && !await this.port.permitted(saved.rule)) {
        blocked.add(id);
        warnings.push(`Cannot restore the query parameter for ${saved.rule.site}; restore site access and retry.`);
        continue;
      }
      const problems = await this.port.undo(id);
      if (problems.length) blocked.add(id);
      warnings.push(...problems);
    }
    if (!active) {
      await this.port.writeConflicts({ pending: [], ignored: [] });
      return warnings;
    }
    for (const rule of rules) {
      if (!rule.enabled || blocked.has(rule.id)) continue;
      if (!await this.port.permitted(rule)) {
        warnings.push(`Query site access for ${rule.site} was not granted. Restore access or disable the rule.`);
        continue;
      }
      for (const id of await this.port.tabs(rule)) await this.process(rule, id);
    }
    return warnings;
  }

  async add(rule: QueryRule): Promise<void> {
    const rules = await this.port.read();
    if (!Number.isSafeInteger(rule.id) || rule.id <= 0 || rules.some((item) => item.id === rule.id)) {
      throw new Error("Invalid or duplicate query rule ID.");
    }
    const next = addQueryRule(rules, rule);
    if (rule.enabled && await this.port.active() && !await this.port.permitted(rule)) {
      throw new Error("Query site access was not granted.");
    }
    await this.port.write(next);
    if (rule.enabled && await this.port.active()) {
      for (const id of await this.port.tabs(rule)) await this.process(rule, id);
    }
  }

  async setEnabled(id: number, enabled: boolean): Promise<string[]> {
    const rules = await this.port.read();
    const rule = rules.find((item) => item.id === id);
    if (!rule) throw new Error("Query rule was not found.");
    const updated = { ...rule, enabled };
    addQueryRule(rules.filter((item) => item.id !== id), updated);
    if (enabled && await this.port.active() && !await this.port.permitted(updated)) {
      throw new Error("Query site access was not granted.");
    }
    await this.port.write(rules.map((item) => item.id === id ? updated : item));
    if (!enabled) {
      await this.clearConflicts(id);
      return this.port.undo(id);
    }
    if (await this.port.active()) {
      for (const tabId of await this.port.tabs(updated)) await this.process(updated, tabId);
    }
    return [];
  }

  async update(rule: QueryRule): Promise<string[]> {
    const rules = await this.port.read();
    if (!rules.some((item) => item.id === rule.id)) throw new Error("Query rule was not found.");
    addQueryRule(rules.filter((item) => item.id !== rule.id), rule);
    if (rule.enabled && await this.port.active() && !await this.port.permitted(rule)) {
      throw new Error("Query site access was not granted.");
    }
    await this.port.write(rules.map((item) => item.id === rule.id ? rule : item));
    await this.clearConflicts(rule.id);
    const warnings = await this.port.undo(rule.id);
    if (!warnings.length && rule.enabled && await this.port.active()) {
      for (const tabId of await this.port.tabs(rule)) await this.process(rule, tabId);
    }
    return warnings;
  }

  async remove(id: number): Promise<string[]> {
    const rules = await this.port.read();
    if (!rules.some((item) => item.id === id)) throw new Error("Query rule was not found.");
    await this.port.write(rules.filter((item) => item.id !== id));
    await this.clearConflicts(id);
    return this.port.undo(id);
  }

  private async clearConflicts(id: number): Promise<void> {
    const state = await this.port.readConflicts();
    state.pending = state.pending.filter((item) => item.ruleId !== id);
    state.ignored = state.ignored.filter((item) => item.ruleId !== id);
    await this.port.writeConflicts(state);
  }

  async processTab(id: number): Promise<void> {
    if (!await this.port.active()) return;
    for (const rule of await this.port.read()) {
      if (!rule.enabled || !(await this.port.tabs(rule)).includes(id)) continue;
      if (!await this.port.permitted(rule)) throw new Error("Query site access was not granted.");
      await this.process(rule, id);
    }
  }

  private async process(rule: QueryRule, id: number): Promise<void> {
    const state = await this.port.readConflicts();
    const tab = await this.port.tab(id);
    if (!tab) return;
    state.pending = state.pending.filter((item) => item.ruleId !== rule.id || item.tab.id !== id);
    if (state.ignored.some((item) =>
      item.ruleId === rule.id && item.tabId === id && item.documentId === tab.documentId)) {
      await this.port.writeConflicts(state);
      return;
    }
    const result = await this.port.apply(rule, id);
    if (result.kind === "warning") await this.port.warn([result.message]);
    if (result.kind === "conflict" && !state.ignored.some((item) =>
      item.ruleId === rule.id && item.tabId === id && item.documentId === result.tab.documentId)) {
      state.pending.push({ ruleId: rule.id, tab: result.tab, values: result.values });
    }
    await this.port.writeConflicts(state);
  }

  async resolve(ruleId: number, tabId: number, decision: "replace" | "keep"): Promise<void> {
    const state = await this.port.readConflicts();
    const conflict = state.pending.find((item) => item.ruleId === ruleId && item.tab.id === tabId);
    const rule = (await this.port.read()).find((item) => item.id === ruleId);
    if (!conflict || !rule || !rule.enabled || !await this.port.active()) {
      throw new Error("The query conflict is no longer available.");
    }
    if (!await this.port.permitted(rule)) throw new Error("Query site access was not granted.");
    if (decision === "replace") {
      await this.port.apply(rule, tabId, { documentId: conflict.tab.documentId, values: conflict.values });
    } else {
      state.ignored.push({ ruleId, tabId, documentId: conflict.tab.documentId });
    }
    state.pending = state.pending.filter((item) => item !== conflict);
    await this.port.writeConflicts(state);
  }
}
