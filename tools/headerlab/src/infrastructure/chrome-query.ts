import type { QueryPort, QueryRecord } from "../application/query-engine.js";
import type { QueryConflictState } from "../application/query-rules.js";
import { addQueryRule, queryMatches, validateQueryRule, type QueryRule } from "../domain/query-rule.js";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function isQueryRule(value: unknown): value is QueryRule {
  return isRecord(value) && typeof value.id === "number" && Number.isSafeInteger(value.id) && value.id > 0 &&
    typeof value.enabled === "boolean" && typeof value.site === "string" &&
    typeof value.includeSubdomains === "boolean" && Array.isArray(value.protocols) &&
    value.protocols.every((protocol: unknown) => protocol === "http" || protocol === "https") &&
    typeof value.name === "string" && typeof value.value === "string" &&
    (value.operation === "set" || value.operation === "remove");
}

export async function readQueryRules(): Promise<QueryRule[]> {
  const { queryRules } = await chrome.storage.local.get("queryRules");
  if (queryRules === undefined) return [];
  if (!Array.isArray(queryRules) || !queryRules.every(isQueryRule)) {
    throw new Error("Saved query rules are invalid.");
  }
  const ids = new Set<number>();
  let rules: QueryRule[] = [];
  try {
    for (const rule of queryRules) {
      if (ids.has(rule.id)) throw new Error("Duplicate query rule ID.");
      ids.add(rule.id);
      rules = addQueryRule(rules, rule);
    }
  } catch (error) {
    throw new Error("Saved query rules are invalid.", { cause: error });
  }
  return rules;
}

function isConflictState(value: unknown): value is QueryConflictState {
  if (!isRecord(value) || !Array.isArray(value.pending) || !Array.isArray(value.ignored)) return false;
  return value.pending.every((item: unknown) =>
    isRecord(item) && typeof item.ruleId === "number" && Number.isSafeInteger(item.ruleId) &&
    isRecord(item.tab) && typeof item.tab.id === "number" && Number.isSafeInteger(item.tab.id) &&
    typeof item.tab.documentId === "string" && item.tab.documentId.length > 0 &&
    typeof item.tab.url === "string" &&
    Array.isArray(item.values) && item.values.every((entry: unknown) => typeof entry === "string"),
  ) && value.ignored.every((item: unknown) =>
    isRecord(item) && typeof item.ruleId === "number" && Number.isSafeInteger(item.ruleId) &&
    typeof item.tabId === "number" && Number.isSafeInteger(item.tabId) &&
    typeof item.documentId === "string" && item.documentId.length > 0,
  );
}

export async function readQueryConflicts(): Promise<QueryConflictState> {
  const { queryConflicts } = await chrome.storage.session.get("queryConflicts");
  if (queryConflicts === undefined) return { pending: [], ignored: [] };
  if (!isConflictState(queryConflicts)) throw new Error("Saved query conflict data is invalid.");
  return queryConflicts;
}

export async function queryTabIds(rule: QueryRule): Promise<number[]> {
  const tabs = await chrome.tabs.query({});
  return tabs.filter((tab) => tab.id !== undefined && tab.url && queryMatches(rule, new URL(tab.url)))
    .map((tab) => {
      if (tab.id === undefined) throw new Error("Cannot identify a matching tab.");
      return tab.id;
    });
}

function isQueryRecord(value: unknown): value is QueryRecord {
  if (!isRecord(value) || !isQueryRule(value.rule) || validateQueryRule(value.rule) !== null ||
    value.ruleId !== value.rule.id || typeof value.tabId !== "number" ||
    !Number.isSafeInteger(value.tabId) || typeof value.documentId !== "string" ||
    !value.documentId || !isRecord(value.undo)) return false;
  const undo = value.undo;
  return typeof undo.origin === "string" && undo.name === value.rule.name &&
    Array.isArray(undo.original) && undo.original.every((item: unknown) => typeof item === "string") &&
    Array.isArray(undo.installed) && undo.installed.every((item: unknown) => typeof item === "string");
}

export const chromeQuery: QueryPort = {
  async tab(id) {
    const tab = (await chrome.tabs.query({})).find((item) => item.id === id);
    if (!tab) return undefined;
    if (!tab.url) throw new Error("Cannot access the tab address. Check site access.");
    const frame = await chrome.webNavigation.getFrame({ tabId: id, frameId: 0 });
    if (!frame?.documentId || !frame.url) throw new Error("Cannot verify the tab's current document.");
    return { id, documentId: frame.documentId, url: frame.url };
  },
  async replace(expected, url) {
    if (new URL(url).origin !== new URL(expected.url).origin) {
      throw new Error("Query changes cannot navigate to another origin.");
    }
    const results = await chrome.scripting.executeScript({
      target: { tabId: expected.id, documentIds: [expected.documentId] },
      func: (before: string, after: string) => {
        if (location.href !== before) return false;
        history.replaceState(history.state, "", after);
        return location.href === after;
      },
      args: [expected.url, url],
    });
    if (results.length !== 1 || typeof results[0].result !== "boolean") {
      throw new Error("Chrome did not confirm the address update.");
    }
    return results[0].result;
  },
  async readUndo() {
    const { queryUndo } = await chrome.storage.session.get("queryUndo");
    if (queryUndo === undefined) return [];
    if (!Array.isArray(queryUndo) || !queryUndo.every(isQueryRecord)) {
      throw new Error("Saved query undo data is invalid.");
    }
    return queryUndo;
  },
  async writeUndo(records) {
    await chrome.storage.session.set({ queryUndo: records });
  },
};
