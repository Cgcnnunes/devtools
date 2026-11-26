import { validHostname } from "./site.js";

export interface CookieRule {
  id: number;
  enabled: boolean;
  site: string;
  includeSubdomains: boolean;
  name: string;
  value: string;
  path: string;
  secure: boolean;
  httpOnly: boolean;
  sameSite: `${chrome.cookies.SameSiteStatus}`;
}

export function cookiePermissionOrigins(rule: CookieRule): string[] {
  const parts = rule.site.split(".");
  const isIp = parts.length === 4 && parts.every((part) => /^\d+$/.test(part));
  const hosts = isIp || parts.length === 1
    ? [rule.site]
    : parts.slice(0, -1).map((_part, index) => parts.slice(index).join("."));
  return hosts.flatMap((host, index) => {
    const scopedHost = index === 0 && rule.includeSubdomains ? `*.${host}` : host;
    return [`http://${scopedHost}/*`, `https://${scopedHost}/*`];
  });
}

export function validateCookieRule(rule: CookieRule): string | null {
  if (!validHostname(rule.site)) return "Enter a valid hostname, such as example.com.";
  if (!/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(rule.name)) return "Enter a valid cookie name.";
  if (!/^[\x21\x23-\x2b\x2d-\x3a\x3c-\x5b\x5d-\x7e]*$/.test(rule.value)) {
    return "Enter a valid cookie value without whitespace, commas, semicolons, quotes or backslashes.";
  }
  if (!rule.path.startsWith("/") || [...rule.path].some((char) =>
    char === ";" || char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127,
  )) return "Enter a valid cookie path beginning with /.";
  if (rule.sameSite === "no_restriction" && !rule.secure) return "SameSite=None requires a Secure cookie.";
  if ((rule.name.startsWith("__Http-") || rule.name.startsWith("__Host-Http-")) &&
      (!rule.secure || !rule.httpOnly)) return "__Http- cookies must be Secure and HttpOnly.";
  if (rule.name.startsWith("__Secure-") && !rule.secure) return "__Secure- cookies must be Secure.";
  if (rule.name.startsWith("__Host-") && (!rule.secure || rule.includeSubdomains || rule.path !== "/")) {
    return "__Host- cookies must be Secure, host-only, and use path /.";
  }
  return null;
}

export function addCookieRule(rules: CookieRule[], rule: CookieRule): CookieRule[] {
  const error = validateCookieRule(rule);
  if (error) throw new Error(error);
  if (rule.enabled && rules.some((existing) => existing.enabled && existing.name === rule.name &&
    (existing.site === rule.site ||
      (existing.includeSubdomains && rule.site.endsWith(`.${existing.site}`)) ||
      (rule.includeSubdomains && existing.site.endsWith(`.${rule.site}`))))) {
    throw new Error("This cookie rule overlaps an existing enabled rule.");
  }
  return [...rules, rule];
}

export function cookieConflicts(rule: CookieRule, cookies: chrome.cookies.Cookie[]): chrome.cookies.Cookie[] {
  return cookies.filter((cookie) => {
    if (cookie.name !== rule.name || cookie.partitionKey) return false;
    const domain = cookie.domain.replace(/^\./, "");
    return domain === rule.site ||
      (!cookie.hostOnly && rule.site.endsWith(`.${domain}`)) ||
      (rule.includeSubdomains && domain.endsWith(`.${rule.site}`));
  });
}

export function cookieUnchanged(expected: chrome.cookies.Cookie, actual: chrome.cookies.Cookie | undefined): boolean {
  return actual !== undefined &&
    expected.name === actual.name && expected.value === actual.value &&
    expected.domain === actual.domain && expected.path === actual.path &&
    expected.storeId === actual.storeId && expected.hostOnly === actual.hostOnly &&
    expected.session === actual.session && expected.expirationDate === actual.expirationDate &&
    expected.secure === actual.secure && expected.httpOnly === actual.httpOnly &&
    expected.sameSite === actual.sameSite &&
    (expected.partitionKey === undefined) === (actual.partitionKey === undefined) &&
    expected.partitionKey?.topLevelSite === actual.partitionKey?.topLevelSite &&
    expected.partitionKey?.hasCrossSiteAncestor === actual.partitionKey?.hasCrossSiteAncestor;
}
