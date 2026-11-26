import { getActivation } from "../application/activation.js";
import { QueryEngine } from "../application/query-engine.js";
import type { QueryRulesPort } from "../application/query-rules.js";
import { chromeQuery, queryTabIds, readQueryConflicts, readQueryRules } from "./chrome-query.js";
import { updateStatus } from "./chrome-status.js";

const engine = new QueryEngine(chromeQuery);

export const chromeQueryRules: QueryRulesPort = {
  read: readQueryRules,
  async write(rules) {
    await chrome.storage.local.set({ queryRules: rules });
  },
  async active() {
    return getActivation(chrome.storage.local);
  },
  async permitted(rule) {
    return chrome.permissions.contains({
      origins: rule.protocols.map((protocol) =>
        `${protocol}://${rule.includeSubdomains ? "*." : ""}${rule.site}/*`),
    });
  },
  tabs: queryTabIds,
  tab: chromeQuery.tab,
  readConflicts: readQueryConflicts,
  async writeConflicts(state) {
    await chrome.storage.session.set({ queryConflicts: state });
  },
  records: chromeQuery.readUndo,
  warn: updateStatus,
  apply: engine.apply.bind(engine),
  undo: engine.undo.bind(engine),
  forgetTab: engine.forgetTab.bind(engine),
};
