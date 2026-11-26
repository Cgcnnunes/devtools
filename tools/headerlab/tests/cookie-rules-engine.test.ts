import { describe, expect, it } from "vitest";
import { CookieRules } from "../src/application/cookie-rules.js";
import type { CookieRule } from "../src/domain/cookie-rule.js";

const rule: CookieRule = {
  id: 1, enabled: true, site: "example.com", includeSubdomains: false,
  name: "test", value: "managed", path: "/", secure: true, httpOnly: false, sameSite: "lax",
};
const original: chrome.cookies.Cookie = {
  name: "test", value: "original", domain: "example.com", path: "/", storeId: "0",
  hostOnly: true, session: true, secure: true, httpOnly: false, sameSite: "lax",
};

describe("cookie rules", () => {
  it("saves a pending rule without replacing conflicts before approval", async () => {
    let rules: CookieRule[] = [];
    let current = [original];
    const manager = new CookieRules({
      read: async () => rules,
      write: async (next) => { rules = next; },
      active: async () => true,
      permitted: async () => true,
      apply: async (_rule, approved) => {
        if (!approved) return { conflicts: current };
        current = [];
        return { conflicts: [] };
      },
      undo: async () => [],
    });

    expect(await manager.add(rule)).toEqual({ conflicts: [original] });
    expect(rules).toEqual([rule]);
    expect(current).toEqual([original]);
    expect(await manager.applySaved(rule.id, [original])).toEqual({ conflicts: [] });
    expect(rules).toEqual([rule]);
    expect(current).toEqual([]);
  });

  it("does not modify cookies when host access is missing", async () => {
    let rules: CookieRule[] = [];
    let applied = false;
    const manager = new CookieRules({
      read: async () => rules,
      write: async (next) => { rules = next; },
      active: async () => true,
      permitted: async () => false,
      apply: async () => { applied = true; return { conflicts: [] }; },
      undo: async () => [],
    });
    await expect(manager.add(rule)).rejects.toThrow(/access/i);
    expect(rules).toEqual([]);
    expect(applied).toBe(false);
  });

  it("does not apply a rule if saving it fails", async () => {
    let applied = false;
    const manager = new CookieRules({
      read: async () => [],
      write: async () => { throw new Error("Cannot save"); },
      active: async () => true,
      permitted: async () => true,
      apply: async () => { applied = true; return { conflicts: [] }; },
      undo: async () => { applied = false; return []; },
    });
    await expect(manager.add(rule)).rejects.toThrow("Cannot save");
    expect(applied).toBe(false);
  });

  it("preserves changed cookies and returns warnings when disabling a rule", async () => {
    let rules = [rule];
    let current = "site-changed";
    const manager = new CookieRules({
      read: async () => rules,
      write: async (next) => { rules = next; },
      active: async () => true,
      permitted: async () => true,
      apply: async () => ({ conflicts: [] }),
      undo: async () => { current = "site-changed"; return ["Cookie changed; preserved."]; },
    });

    expect(await manager.disable(rule.id)).toEqual(["Cookie changed; preserved."]);
    expect(rules[0].enabled).toBe(false);
    expect(current).toBe("site-changed");
  });

  it("requests conflict approval before enabling a saved rule", async () => {
    let rules = [{ ...rule, enabled: false }];
    const manager = new CookieRules({
      read: async () => rules,
      write: async (next) => { rules = next; },
      active: async () => true,
      permitted: async () => true,
      apply: async (_rule, approved) => ({ conflicts: approved ? [] : [original] }),
      undo: async () => [],
    });

    expect(await manager.enable(rule.id)).toEqual({ conflicts: [original] });
    expect(rules[0].enabled).toBe(true);
    expect(await manager.applySaved(rule.id, [original])).toEqual({ conflicts: [] });
    expect(rules[0].enabled).toBe(true);
  });

  it("does not apply an edit when a site-modified cookie cannot be restored", async () => {
    let rules = [rule];
    let applied = false;
    const manager = new CookieRules({
      read: async () => rules,
      write: async (next) => { rules = next; },
      active: async () => true,
      permitted: async () => true,
      apply: async () => { applied = true; return { conflicts: [] }; },
      undo: async () => ["Cookie changed; preserved."],
    });

    expect(await manager.update({ ...rule, value: "next" })).toEqual({
      conflicts: [], warnings: ["Cookie changed; preserved."],
    });
    expect(applied).toBe(false);
    expect(rules[0].value).toBe("next");
  });
});
