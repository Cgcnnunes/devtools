import type { CookiePort, CookieUndo } from "../application/cookie-engine.js";
import { addCookieRule, cookieUnchanged, validateCookieRule, type CookieRule } from "../domain/cookie-rule.js";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function isCookieRule(value: unknown): value is CookieRule {
  if (!isRecord(value)) return false;
  return typeof value.id === "number" && Number.isSafeInteger(value.id) && value.id > 0 &&
    typeof value.enabled === "boolean" && typeof value.site === "string" &&
    typeof value.includeSubdomains === "boolean" && typeof value.name === "string" &&
    typeof value.value === "string" && typeof value.path === "string" &&
    typeof value.secure === "boolean" && typeof value.httpOnly === "boolean" &&
    (value.sameSite === "lax" || value.sameSite === "strict" ||
      value.sameSite === "no_restriction" || value.sameSite === "unspecified");
}

export async function readCookieRules(): Promise<CookieRule[]> {
  const { cookieRules } = await chrome.storage.local.get("cookieRules");
  if (cookieRules === undefined) return [];
  if (!Array.isArray(cookieRules) || !cookieRules.every(isCookieRule)) {
    throw new Error("Saved cookie rules are invalid.");
  }
  const ids = new Set<number>();
  let rules: CookieRule[] = [];
  try {
    for (const rule of cookieRules) {
      if (ids.has(rule.id)) throw new Error("Duplicate cookie rule ID.");
      ids.add(rule.id);
      rules = addCookieRule(rules, rule);
    }
  } catch (error) {
    throw new Error("Saved cookie rules are invalid.", { cause: error });
  }
  return rules;
}

export function isCookie(value: unknown): value is chrome.cookies.Cookie {
  if (!isRecord(value)) return false;
  return typeof value.name === "string" && typeof value.value === "string" &&
    typeof value.domain === "string" && typeof value.path === "string" &&
    typeof value.storeId === "string" && typeof value.hostOnly === "boolean" &&
    typeof value.httpOnly === "boolean" && typeof value.secure === "boolean" &&
    typeof value.session === "boolean" &&
    (value.expirationDate === undefined || typeof value.expirationDate === "number") &&
    value.partitionKey === undefined &&
    (value.sameSite === "lax" || value.sameSite === "strict" ||
      value.sameSite === "no_restriction" || value.sameSite === "unspecified");
}

function isUndo(value: unknown): value is CookieUndo {
  return isRecord(value) && isCookieRule(value.rule) && validateCookieRule(value.rule) === null &&
    typeof value.storeId === "string" &&
    Array.isArray(value.original) && value.original.every(isCookie) &&
    (value.restoring === undefined || typeof value.restoring === "boolean") &&
    (value.installed === null || isCookie(value.installed));
}

function cookieUrl(domain: string, path: string, secure: boolean): string {
  return `${secure ? "https" : "http"}://${domain.replace(/^\./, "")}${encodeURI(path).replaceAll("?", "%3F").replaceAll("#", "%23")}`;
}

function cookieDetails(cookie: chrome.cookies.Cookie): chrome.cookies.CookieDetails {
  return {
    name: cookie.name,
    storeId: cookie.storeId,
    url: cookieUrl(cookie.domain, cookie.path, cookie.secure),
  };
}

function sameIdentity(left: chrome.cookies.Cookie, right: chrome.cookies.Cookie): boolean {
  return left.name === right.name && left.storeId === right.storeId &&
    left.domain.replace(/^\./, "") === right.domain.replace(/^\./, "") &&
    left.path === right.path && left.partitionKey === undefined && right.partitionKey === undefined;
}

function cookieSetDetails(cookie: chrome.cookies.Cookie): chrome.cookies.SetDetails {
  const details: chrome.cookies.SetDetails = {
    ...cookieDetails(cookie),
    value: cookie.value,
    path: cookie.path,
    secure: cookie.secure,
    httpOnly: cookie.httpOnly,
    sameSite: cookie.sameSite,
  };
  if (!cookie.hostOnly) details.domain = cookie.domain;
  return details;
}

export const chromeCookies: CookiePort = {
  async stores() {
    return (await chrome.cookies.getAllCookieStores()).map((store) => store.id);
  },
  async list(name, storeId) {
    return chrome.cookies.getAll({ name, storeId });
  },
  async remove(cookie) {
    const filter = { name: cookie.name, storeId: cookie.storeId };
    const current = (await chrome.cookies.getAll(filter)).find((item) => sameIdentity(item, cookie));
    if (!cookieUnchanged(cookie, current)) {
      throw new Error("The cookie changed before it could be removed.");
    }
    // cookies.remove can delete multiple same-name cookies matching the URL.
    await chrome.cookies.set({ ...cookieSetDetails(cookie), expirationDate: 1 });
    if ((await chrome.cookies.getAll(filter)).some((item) => sameIdentity(item, cookie))) {
      throw new Error("Chrome could not remove the cookie safely.");
    }
  },
  async set(rule, storeId) {
    const details: chrome.cookies.SetDetails = {
      url: cookieUrl(rule.site, rule.path, rule.secure),
      name: rule.name,
      value: rule.value,
      path: rule.path,
      storeId,
      secure: rule.secure,
      httpOnly: rule.httpOnly,
      sameSite: rule.sameSite,
    };
    if (rule.includeSubdomains) details.domain = rule.site;
    const cookie = await chrome.cookies.set(details);
    if (!cookie) throw new Error("Chrome could not set the cookie.");
    if (cookie.name !== rule.name || cookie.value !== rule.value ||
      cookie.domain.replace(/^\./, "") !== rule.site || cookie.path !== rule.path ||
      cookie.storeId !== storeId || cookie.hostOnly === rule.includeSubdomains ||
      !cookie.session || cookie.expirationDate !== undefined ||
      cookie.secure !== rule.secure || cookie.httpOnly !== rule.httpOnly ||
      cookie.sameSite !== rule.sameSite || cookie.partitionKey !== undefined) {
      throw new Error("Chrome created a cookie with unexpected attributes.");
    }
    return cookie;
  },
  async restore(cookie) {
    const current = await chrome.cookies.getAll({ name: cookie.name, storeId: cookie.storeId });
    if (current.some((item) => sameIdentity(item, cookie))) {
      throw new Error("The cookie changed before it could be restored.");
    }
    const details = cookieSetDetails(cookie);
    if (cookie.expirationDate !== undefined) details.expirationDate = cookie.expirationDate;
    const restored = await chrome.cookies.set(details);
    if (!cookieUnchanged(cookie, restored ?? undefined)) {
      throw new Error("Chrome could not restore the cookie with its original attributes.");
    }
  },
  async readUndo() {
    const { cookieUndo } = await chrome.storage.session.get("cookieUndo");
    if (cookieUndo === undefined) return [];
    if (!Array.isArray(cookieUndo) || !cookieUndo.every(isUndo)) {
      throw new Error("Saved cookie undo data is invalid.");
    }
    return cookieUndo;
  },
  async writeUndo(entries) {
    await chrome.storage.session.set({ cookieUndo: entries });
  },
};
