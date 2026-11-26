import { isCookie } from "./chrome-cookies.js";
import { cookieUnchanged } from "../domain/cookie-rule.js";

export interface CookieConflict {
  ruleId: number;
  cookies: chrome.cookies.Cookie[];
  revision: string;
}

function isConflict(value: unknown): value is CookieConflict {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  if (!("ruleId" in value) || typeof value.ruleId !== "number" ||
      !Number.isSafeInteger(value.ruleId) || value.ruleId <= 0 ||
      !("revision" in value) || typeof value.revision !== "string" || !value.revision ||
      !("cookies" in value) || !Array.isArray(value.cookies)) return false;
  return value.cookies.length > 0 && value.cookies.every(isCookie);
}

export async function readCookieConflicts(): Promise<CookieConflict[]> {
  const { cookieConflicts } = await chrome.storage.session.get("cookieConflicts");
  if (cookieConflicts === undefined) return [];
  if (!Array.isArray(cookieConflicts) || !cookieConflicts.every(isConflict)) {
    throw new Error("Saved cookie conflict data is invalid.");
  }
  return cookieConflicts;
}

export async function writeCookieConflict(ruleId: number, cookies: chrome.cookies.Cookie[]): Promise<void> {
  const previous = await readCookieConflicts();
  const current = previous.find((item) => item.ruleId === ruleId);
  const pending = previous.filter((item) => item.ruleId !== ruleId);
  if (cookies.length) {
    const unchanged = current && current.cookies.length === cookies.length &&
      current.cookies.every((cookie) => cookies.some((item) => cookieUnchanged(cookie, item)));
    pending.push({ ruleId, cookies, revision: unchanged ? current.revision : crypto.randomUUID() });
  }
  await chrome.storage.session.set({ cookieConflicts: pending });
}

export async function pruneCookieConflicts(activeRuleIds: number[]): Promise<void> {
  const pending = await readCookieConflicts();
  const remaining = pending.filter((item) => activeRuleIds.includes(item.ruleId));
  if (remaining.length !== pending.length) await chrome.storage.session.set({ cookieConflicts: remaining });
}
