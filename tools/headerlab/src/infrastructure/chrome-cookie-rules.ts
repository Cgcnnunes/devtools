import { getActivation } from "../application/activation.js";
import { CookieEngine } from "../application/cookie-engine.js";
import type { CookieReconciliationPort } from "../application/cookie-reconciliation.js";
import { CookieRules, type CookieRulesPort } from "../application/cookie-rules.js";
import { cookiePermissionOrigins } from "../domain/cookie-rule.js";
import { writeCookieConflict } from "./chrome-cookie-conflicts.js";
import { chromeCookies, readCookieRules } from "./chrome-cookies.js";

const engine = new CookieEngine(chromeCookies);
const shared = {
  read: readCookieRules,
  active: () => getActivation(chrome.storage.local),
  permitted: (rule: Parameters<typeof cookiePermissionOrigins>[0]) =>
    chrome.permissions.contains({ origins: cookiePermissionOrigins(rule) }),
  apply: engine.apply.bind(engine),
  undo: engine.undo.bind(engine),
};

const port: CookieRulesPort = {
  ...shared,
  async write(rules) {
    await chrome.storage.local.set({ cookieRules: rules });
  },
};

export const cookieRules = new CookieRules(port);
export const cookieReconciliation: CookieReconciliationPort = {
  ...shared,
  records: chromeCookies.readUndo,
  recover: engine.recover.bind(engine),
  conflicts: writeCookieConflict,
};
