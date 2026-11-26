import { afterEach, expect, it, vi } from "vitest";
import { chromeCookies, readCookieRules } from "../src/infrastructure/chrome-cookies.js";
import type { CookieRule } from "../src/domain/cookie-rule.js";

afterEach(() => vi.unstubAllGlobals());

it("refuses to remove a cookie that changed after it was inspected", async () => {
  const original: chrome.cookies.Cookie = {
    name: "test", value: "old", domain: "example.com", path: "/", storeId: "0",
    hostOnly: true, session: true, secure: true, httpOnly: false, sameSite: "lax",
  };
  const set = vi.fn();
  vi.stubGlobal("chrome", {
    cookies: {
      getAll: vi.fn().mockResolvedValue([{ ...original, value: "site-changed" }]),
      set,
    },
  });

  await expect(chromeCookies.remove(original)).rejects.toThrow(/changed/i);
  expect(set).not.toHaveBeenCalled();
});

it("refuses to overwrite a cookie created before restoration", async () => {
  const original: chrome.cookies.Cookie = {
    name: "test", value: "old", domain: "example.com", path: "/", storeId: "0",
    hostOnly: true, session: true, secure: true, httpOnly: false, sameSite: "lax",
  };
  const set = vi.fn();
  vi.stubGlobal("chrome", {
    cookies: {
      getAll: vi.fn().mockResolvedValue([{ ...original, value: "new" }]),
      set,
    },
  });

  await expect(chromeCookies.restore(original)).rejects.toThrow(/changed/i);
  expect(set).not.toHaveBeenCalled();
});

it("reports when Chrome restores different cookie attributes", async () => {
  const original: chrome.cookies.Cookie = {
    name: "test", value: "old", domain: "example.com", path: "/", storeId: "0",
    hostOnly: true, session: true, secure: true, httpOnly: false, sameSite: "lax",
  };
  vi.stubGlobal("chrome", {
    cookies: {
      getAll: vi.fn().mockResolvedValue([]),
      set: vi.fn().mockResolvedValue({ ...original, httpOnly: true }),
    },
  });

  await expect(chromeCookies.restore(original)).rejects.toThrow(/restor/i);
});

it("reports when Chrome creates a cookie with different attributes", async () => {
  const rule: CookieRule = {
    id: 1, enabled: true, site: "example.com", includeSubdomains: false,
    name: "test", value: "managed", path: "/", secure: true, httpOnly: true, sameSite: "lax",
  };
  vi.stubGlobal("chrome", {
    cookies: {
      set: vi.fn().mockResolvedValue({
        name: "test", value: "managed", domain: "example.com", path: "/", storeId: "0",
        hostOnly: true, session: true, secure: true, httpOnly: false, sameSite: "lax",
      }),
    },
  });

  await expect(chromeCookies.set(rule, "0")).rejects.toThrow(/attributes/i);
});

it("rejects saved cookie rules with overlapping enabled scopes", async () => {
  const rule: CookieRule = {
    id: 1, enabled: true, site: "example.com", includeSubdomains: true,
    name: "test", value: "managed", path: "/", secure: true, httpOnly: true, sameSite: "lax",
  };
  vi.stubGlobal("chrome", {
    storage: { local: { get: vi.fn().mockResolvedValue({
      cookieRules: [rule, { ...rule, id: 2, site: "api.example.com" }],
    }) } },
  });

  await expect(readCookieRules()).rejects.toThrow(/saved cookie rules/i);
});
