import { HeaderEngine } from "./application/header-engine.js";
import { QueryRules } from "./application/query-rules.js";
import { reconcileCookies } from "./application/cookie-reconciliation.js";
import { chromeHeaders, isHeaderRule } from "./infrastructure/chrome-headers.js";
import { isQueryRule, readQueryRules } from "./infrastructure/chrome-query.js";
import { chromeQueryRules } from "./infrastructure/chrome-query-rules.js";
import { updateStatus } from "./infrastructure/chrome-status.js";
import { cookieReconciliation, cookieRules } from "./infrastructure/chrome-cookie-rules.js";
import { isCookieRule, readCookieRules } from "./infrastructure/chrome-cookies.js";
import { pruneCookieConflicts, readCookieConflicts, writeCookieConflict } from "./infrastructure/chrome-cookie-conflicts.js";

const engine = new HeaderEngine(chromeHeaders);
const queries = new QueryRules(chromeQueryRules);
let reconciled = false;

async function ensureReconciled(): Promise<void> {
  if (!reconciled) {
    await engine.reconcile();
    const active = await cookieReconciliation.active();
    const rules = await readCookieRules();
    await pruneCookieConflicts(active ? rules.filter((rule) => rule.enabled).map((rule) => rule.id) : []);
    await updateStatus(await reconcileCookies(cookieReconciliation));
    await updateStatus(await queries.reconcile());
    reconciled = true;
  }
}

let queue: Promise<void> = ensureReconciled().catch(() => {
  console.error("HeaderLab could not reconcile saved header rules.");
});

chrome.runtime.onStartup.addListener(() => {
  queue = queue.then(ensureReconciled).catch(() => {
    console.error("HeaderLab could not reconcile saved header rules.");
  });
});

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function handleMessage(message: unknown): Promise<void> {
  if (!isRecord(message)) throw new Error("Invalid request.");
  if (message.type === "reconcile") {
    reconciled = false;
    await ensureReconciled();
    return;
  }
  if (message.type === "set-activation" && typeof message.enabled === "boolean") {
    await engine.setEnabled(message.enabled);
    await updateStatus(await reconcileCookies(cookieReconciliation));
    await updateStatus(await queries.reconcile());
    return;
  }
  if (message.type === "add-header" && isHeaderRule(message.rule)) {
    const state = await chromeHeaders.read();
    const id = Math.max(0, ...state.rules.map((rule) => rule.id)) + 1;
    await engine.add({ ...message.rule, id });
    return;
  }
  if (message.type === "update-header" && isHeaderRule(message.rule)) {
    await engine.update(message.rule);
    return;
  }
  if (message.type === "toggle-header" && typeof message.id === "number" && typeof message.enabled === "boolean") {
    await engine.setRuleEnabled(message.id, message.enabled);
    return;
  }
  if (message.type === "remove-header" && typeof message.id === "number") {
    await engine.remove(message.id);
    return;
  }
  if (message.type === "add-cookie" && isCookieRule(message.rule)) {
    const rules = await readCookieRules();
    const records = await cookieReconciliation.records();
    const id = Math.max(0, ...rules.map((rule) => rule.id), ...records.map((record) => record.rule.id)) + 1;
    const result = await cookieRules.add({ ...message.rule, id });
    await writeCookieConflict(id, result.conflicts);
    await updateStatus();
    return;
  }
  if (message.type === "update-cookie" && isCookieRule(message.rule)) {
    await writeCookieConflict(message.rule.id, []);
    const result = await cookieRules.update(message.rule);
    await writeCookieConflict(message.rule.id, result.conflicts);
    await updateStatus(result.warnings);
    return;
  }
  if (message.type === "toggle-cookie" && typeof message.id === "number" && typeof message.enabled === "boolean") {
    if (message.enabled) {
      const result = await cookieRules.enable(message.id);
      await writeCookieConflict(message.id, result.conflicts);
    } else {
      const warnings = await cookieRules.disable(message.id);
      await writeCookieConflict(message.id, []);
      await updateStatus(warnings);
    }
    await updateStatus();
    return;
  }
  if (message.type === "remove-cookie" && typeof message.id === "number") {
    const warnings = await cookieRules.remove(message.id);
    await writeCookieConflict(message.id, []);
    await updateStatus(warnings);
    return;
  }
  if (message.type === "resolve-cookie" && typeof message.id === "number" &&
      typeof message.revision === "string" && (message.decision === "replace" || message.decision === "keep")) {
    const conflict = (await readCookieConflicts()).find((item) =>
      item.ruleId === message.id && item.revision === message.revision);
    if (!conflict) throw new Error("The cookie conflict changed. Review it again.");
    if (message.decision === "replace") {
      const result = await cookieRules.applySaved(message.id, conflict.cookies);
      await writeCookieConflict(message.id, result.conflicts);
    } else {
      await updateStatus(await cookieRules.disable(message.id));
      await writeCookieConflict(message.id, []);
    }
    await updateStatus();
    return;
  }
  if (message.type === "add-query" && isQueryRule(message.rule)) {
    const rules = await readQueryRules();
    const id = Math.max(0, ...rules.map((rule) => rule.id)) + 1;
    await queries.add({ ...message.rule, id });
    await updateStatus();
    return;
  }
  if (message.type === "update-query" && isQueryRule(message.rule)) {
    await updateStatus(await queries.update(message.rule));
    return;
  }
  if (message.type === "toggle-query" && typeof message.id === "number" && typeof message.enabled === "boolean") {
    await updateStatus(await queries.setEnabled(message.id, message.enabled));
    return;
  }
  if (message.type === "remove-query" && typeof message.id === "number") {
    await updateStatus(await queries.remove(message.id));
    return;
  }
  if (message.type === "resolve-query" && typeof message.id === "number" && typeof message.tabId === "number" &&
      (message.decision === "keep" || message.decision === "replace")) {
    await queries.resolve(message.id, message.tabId, message.decision);
    await updateStatus();
    return;
  }
  if (message.type === "clear-warnings") {
    await updateStatus([], true);
    return;
  }
  throw new Error("Invalid request.");
}

function schedule(action: () => Promise<void>): void {
  const task = queue.then(async () => {
    await ensureReconciled();
    await action();
    await updateStatus();
  });
  queue = task.catch(async () => {
    console.error("HeaderLab could not update query rules.");
    await updateStatus(["Query rules could not be updated. Open HeaderLab to review."]);
  }).catch(() => {
    console.error("HeaderLab could not report a query-rule error.");
  });
}

chrome.webNavigation.onCompleted.addListener((details) => {
  if (details.frameId === 0) schedule(async () => {
    await updateStatus(await reconcileCookies(cookieReconciliation));
    await queries.processTab(details.tabId);
  });
});
chrome.webNavigation.onHistoryStateUpdated.addListener((details) => {
  if (details.frameId === 0) schedule(() => queries.processTab(details.tabId));
});
chrome.tabs.onRemoved.addListener((tabId) => schedule(async () => {
  await queries.forgetTab(tabId);
  await updateStatus(await reconcileCookies(cookieReconciliation));
}));

chrome.runtime.onMessage.addListener((message: unknown, sender, respond) => {
  if (sender.id !== chrome.runtime.id) return false;
  const task = queue.then(async () => {
    await ensureReconciled();
    await handleMessage(message);
  });
  queue = task.then(
    () => { respond({ ok: true }); },
    (error: unknown) => {
      respond({ ok: false, error: error instanceof Error ? error.message : "The request failed." });
    },
  );
  return true;
});
