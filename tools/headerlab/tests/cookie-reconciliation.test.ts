import { expect, it } from "vitest";
import { reconcileCookies, type CookieReconciliationPort } from "../src/application/cookie-reconciliation.js";
import type { CookieRule } from "../src/domain/cookie-rule.js";

const rule: CookieRule = {
  id: 1, enabled: true, site: "example.com", includeSubdomains: false,
  name: "test", value: "managed", path: "/", secure: true, httpOnly: false, sameSite: "lax",
};

it("restores managed cookies on global deactivation without applying rules", async () => {
  let restored = false;
  let applied = false;
  const port: CookieReconciliationPort = {
    read: async () => [rule],
    active: async () => false,
    records: async () => [{ rule, storeId: "normal", original: [], installed: null }],
    permitted: async () => true,
    recover: async () => [],
    undo: async () => { restored = true; return []; },
    apply: async () => { applied = true; return { conflicts: [] }; },
    conflicts: async () => {},
  };
  expect(await reconcileCookies(port)).toEqual([]);
  expect(restored).toBe(true);
  expect(applied).toBe(false);
});

it("does not apply an edited rule if its previous cookie cannot safely be restored", async () => {
  let applied = false;
  const port: CookieReconciliationPort = {
    read: async () => [{ ...rule, value: "next" }],
    active: async () => true,
    records: async () => [{ rule, storeId: "normal", original: [], installed: null }],
    permitted: async () => true,
    recover: async () => [],
    undo: async () => ["Cookie changed; preserved."],
    apply: async () => { applied = true; return { conflicts: [] }; },
    conflicts: async () => {},
  };
  expect(await reconcileCookies(port)).toEqual(["Cookie changed; preserved."]);
  expect(applied).toBe(false);
});

it("keeps unavailable cookie backups and reports missing permission", async () => {
  let restored = false;
  const port: CookieReconciliationPort = {
    read: async () => [rule],
    active: async () => false,
    records: async () => [{ rule, storeId: "normal", original: [], installed: null }],
    permitted: async () => false,
    recover: async () => [],
    undo: async () => { restored = true; return []; },
    apply: async () => ({ conflicts: [] }),
    conflicts: async () => {},
  };
  expect(await reconcileCookies(port)).toEqual([expect.stringMatching(/restore site access/i)]);
  expect(restored).toBe(false);
});

it("clears a deleted rule's pending conflict when restoring its journal", async () => {
  const pending = new Set([rule.id]);
  const port: CookieReconciliationPort = {
    read: async () => [],
    active: async () => true,
    records: async () => [{ rule, storeId: "normal", original: [], installed: null }],
    permitted: async () => true,
    recover: async () => [],
    undo: async () => [],
    apply: async () => ({ conflicts: [] }),
    conflicts: async (id, cookies) => { if (!cookies.length) pending.delete(id); },
  };
  await reconcileCookies(port);
  expect([...pending]).toEqual([]);
});
