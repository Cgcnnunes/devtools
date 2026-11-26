import { getActivation } from "../application/activation.js";
import type { HeaderAdapter, HeaderState } from "../application/header-engine.js";
import {
  networkRule,
  validateHeaderRule,
  type HeaderRule,
} from "../domain/header-rule.js";

function isHeaderRule(value: unknown): value is HeaderRule {
  if (!isRecord(value)) return false;
  const record = value;
  return typeof record.id === "number" && Number.isSafeInteger(record.id) && record.id > 0 &&
    typeof record.enabled === "boolean" &&
    typeof record.site === "string" &&
    typeof record.includeSubdomains === "boolean" &&
    Array.isArray(record.protocols) &&
    record.protocols.every((protocol: unknown) => protocol === "http" || protocol === "https") &&
    typeof record.name === "string" &&
    (record.operation === "set" || record.operation === "append" || record.operation === "remove") &&
    typeof record.value === "string";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export async function readHeaderState(): Promise<HeaderState> {
  const enabled = await getActivation(chrome.storage.local);
  const { headerRules } = await chrome.storage.local.get("headerRules");
  if (headerRules === undefined) return { enabled, rules: [] };
  if (!Array.isArray(headerRules) || !headerRules.every(isHeaderRule)) {
    throw new Error("Saved header rules are invalid.");
  }
  if (headerRules.some((rule) => validateHeaderRule(rule))) {
    throw new Error("Saved header rules are invalid.");
  }
  return { enabled, rules: headerRules };
}

export const chromeHeaders: HeaderAdapter = {
  read: readHeaderState,
  async write(state) {
    await chrome.storage.local.set({ enabled: state.enabled, headerRules: state.rules });
  },
  async apply(rules) {
    const installed = await chrome.declarativeNetRequest.getDynamicRules();
    const operations = {
      set: chrome.declarativeNetRequest.HeaderOperation.SET,
      append: chrome.declarativeNetRequest.HeaderOperation.APPEND,
      remove: chrome.declarativeNetRequest.HeaderOperation.REMOVE,
    };
    const addRules = rules.map((rule): chrome.declarativeNetRequest.Rule => {
      const prepared = networkRule(rule);
      const modification: chrome.declarativeNetRequest.ModifyHeaderInfo = {
        header: rule.name,
        operation: operations[rule.operation],
      };
      if (rule.operation !== "remove") modification.value = rule.value;
      return {
        id: prepared.id,
        action: {
          type: chrome.declarativeNetRequest.RuleActionType.MODIFY_HEADERS,
          requestHeaders: [modification],
        },
        condition: prepared.condition,
      };
    });
    await chrome.declarativeNetRequest.updateDynamicRules({
      removeRuleIds: installed.map((rule) => rule.id),
      addRules,
    });
  },
};

export { isHeaderRule };
