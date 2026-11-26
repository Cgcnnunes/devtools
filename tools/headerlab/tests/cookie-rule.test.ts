import { describe, expect, it } from "vitest";
import {
  cookieConflicts,
  cookiePermissionOrigins,
  addCookieRule,
  cookieUnchanged,
  validateCookieRule,
  type CookieRule,
} from "../src/domain/cookie-rule.js";

const rule: CookieRule = {
  id: 1,
  enabled: true,
  site: "example.com",
  includeSubdomains: false,
  name: "test",
  value: "enabled",
  path: "/",
  secure: true,
  httpOnly: false,
  sameSite: "lax",
};

const cookie: chrome.cookies.Cookie = {
  domain: "example.com",
  name: "test",
  value: "old",
  path: "/account",
  storeId: "0",
  hostOnly: true,
  session: false,
  expirationDate: 2000000000,
  secure: true,
  httpOnly: true,
  sameSite: "lax",
};

describe("cookie rules", () => {
  it("rejects unsafe or invalid cookie attributes", () => {
    expect(validateCookieRule({ ...rule, path: "account" })).toMatch(/path/i);
    expect(validateCookieRule({ ...rule, value: "a;b" })).toMatch(/value/i);
    expect(validateCookieRule({ ...rule, secure: false, sameSite: "no_restriction" })).toMatch(/secure/i);
    expect(validateCookieRule({ ...rule, name: "__Host-test", includeSubdomains: true })).toMatch(/host/i);
    expect(validateCookieRule({ ...rule, name: "__Http-test", httpOnly: false })).toMatch(/httponly/i);
  });

  it("detects existing same-name cookies across paths without including unrelated sites", () => {
    expect(cookieConflicts(rule, [
      cookie,
      { ...cookie, path: "/" },
      { ...cookie, domain: "other.example.com" },
      { ...cookie, domain: "example.com.evil.test" },
      { ...cookie, name: "other" },
    ])).toEqual([cookie, { ...cookie, path: "/" }]);
  });

  it("requests both schemes for the selected host and its possible cookie parents", () => {
    expect(cookiePermissionOrigins({ ...rule, site: "api.example.com" })).toEqual([
      "http://api.example.com/*", "https://api.example.com/*",
      "http://example.com/*", "https://example.com/*",
    ]);
    expect(cookiePermissionOrigins({ ...rule, site: "127.0.0.1" })).toEqual([
      "http://127.0.0.1/*", "https://127.0.0.1/*",
    ]);
  });

  it("does not undo a cookie changed by the site", () => {
    expect(cookieUnchanged(cookie, { ...cookie })).toBe(true);
    expect(cookieUnchanged(cookie, { ...cookie, value: "site-changed" })).toBe(false);
    expect(cookieUnchanged(cookie, { ...cookie, httpOnly: false })).toBe(false);
    expect(cookieUnchanged(cookie, { ...cookie, partitionKey: {} })).toBe(false);
    expect(cookieUnchanged(cookie, undefined)).toBe(false);
  });

  it("rejects enabled same-name rules whose site scopes overlap", () => {
    const parent = { ...rule, includeSubdomains: true };
    expect(() => addCookieRule([parent], { ...rule, id: 2, site: "api.example.com" })).toThrow(/overlap/i);
    expect(addCookieRule([rule], { ...rule, id: 2, site: "api.example.com" })).toHaveLength(2);
    expect(addCookieRule([parent], { ...rule, id: 2, site: "api.example.com", enabled: false })).toHaveLength(2);
    expect(addCookieRule([parent], { ...rule, id: 2, site: "api.example.com", name: "Test" })).toHaveLength(2);
  });
});
