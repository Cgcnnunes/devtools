import { describe, expect, it } from "vitest";
import { QueryEngine, type QueryPort, type QueryRecord, type QueryTab } from "../src/application/query-engine.js";
import { QueryRules, type QueryConflictState, type QueryRulesPort } from "../src/application/query-rules.js";
import type { QueryRule } from "../src/domain/query-rule.js";

const rule: QueryRule = {
  id: 1, enabled: true, site: "example.com", includeSubdomains: false,
  protocols: ["https"], name: "debug", value: "on", operation: "set",
};

function fake() {
  let tab: QueryTab = { id: 1, documentId: "first", url: "https://example.com/?debug=old" };
  let rules: QueryRule[] = [];
  let undo: QueryRecord[] = [];
  let conflicts: QueryConflictState = { pending: [], ignored: [] };
  let active = true;
  const queryPort: QueryPort = {
    tab: async () => ({ ...tab }),
    replace: async (before, url) => {
      if (before.url !== tab.url || before.documentId !== tab.documentId) return false;
      tab = { ...tab, url };
      return true;
    },
    readUndo: async () => structuredClone(undo),
    writeUndo: async (records) => { undo = structuredClone(records); },
  };
  const port: QueryRulesPort = {
    read: async () => structuredClone(rules),
    write: async (next) => { rules = structuredClone(next); },
    active: async () => active,
    permitted: async () => true,
    tabs: async () => [tab.id],
    tab: queryPort.tab,
    readConflicts: async () => structuredClone(conflicts),
    writeConflicts: async (next) => { conflicts = structuredClone(next); },
    records: queryPort.readUndo,
    warn: async () => {},
    apply: (...args) => new QueryEngine(queryPort).apply(...args),
    undo: (id) => new QueryEngine(queryPort).undo(id),
    forgetTab: (id) => new QueryEngine(queryPort).forgetTab(id),
  };
  return {
    manager: new QueryRules(port),
    port,
    tab: () => tab,
    setTab: (next: QueryTab) => { tab = next; },
    setActive: (next: boolean) => { active = next; },
  };
}

describe("query rules", () => {
  it("records conflicts without changing the address until approved", async () => {
    const state = fake();
    await state.manager.add(rule);
    expect(state.tab().url).toBe("https://example.com/?debug=old");
    const conflicts = await state.port.readConflicts();
    expect(conflicts.pending).toHaveLength(1);
    await state.manager.resolve(1, 1, "replace");
    expect(state.tab().url).toBe("https://example.com/?debug=on");
    expect((await state.port.readConflicts()).pending).toEqual([]);
  });

  it("keeps a site's value for the current document when declined", async () => {
    const state = fake();
    await state.manager.add(rule);
    await state.manager.resolve(1, 1, "keep");
    await state.manager.processTab(1);
    expect(state.tab().url).toBe("https://example.com/?debug=old");
    expect((await state.port.readConflicts()).pending).toEqual([]);
    state.setTab({ id: 1, documentId: "first", url: "https://example.com/" });
    await state.manager.processTab(1);
    expect(state.tab().url).toBe("https://example.com/");
  });

  it("rejects stale approvals after navigation", async () => {
    const state = fake();
    await state.manager.add(rule);
    state.setTab({ id: 1, documentId: "second", url: "https://example.com/?debug=old" });
    await expect(state.manager.resolve(1, 1, "replace")).rejects.toThrow(/document/i);
    expect(state.tab().url).toBe("https://example.com/?debug=old");
  });

  it("restores managed values when disabled", async () => {
    const state = fake();
    await state.manager.add(rule);
    await state.manager.resolve(1, 1, "replace");
    expect(await state.manager.setEnabled(1, false)).toEqual([]);
    expect(state.tab().url).toBe("https://example.com/?debug=old");
    expect((await state.port.read())[0].enabled).toBe(false);
  });

  it("warns without overwriting site changes when disabled", async () => {
    const state = fake();
    await state.manager.add(rule);
    await state.manager.resolve(1, 1, "replace");
    state.setTab({ id: 1, documentId: "first", url: "https://example.com/?debug=site" });
    expect(await state.manager.setEnabled(1, false)).toHaveLength(1);
    expect(state.tab().url).toBe("https://example.com/?debug=site");
  });

  it("restores the previous value before applying an edited rule", async () => {
    const state = fake();
    await state.manager.add(rule);
    await state.manager.resolve(1, 1, "replace");
    expect(await state.manager.update({ ...rule, value: "next" })).toEqual([]);
    expect(state.tab().url).toBe("https://example.com/?debug=old");
    expect((await state.port.readConflicts()).pending).toHaveLength(1);
    await state.manager.resolve(1, 1, "replace");
    expect(state.tab().url).toBe("https://example.com/?debug=next");
    expect(await state.manager.remove(1)).toEqual([]);
    expect(state.tab().url).toBe("https://example.com/?debug=old");
    expect(await state.port.read()).toEqual([]);
  });

  it("reconciles an interruption after saving an edit", async () => {
    const state = fake();
    await state.manager.add(rule);
    await state.manager.resolve(1, 1, "replace");
    await state.port.write([{ ...rule, value: "next" }]);
    expect(await state.manager.reconcile()).toEqual([]);
    expect(state.tab().url).toBe("https://example.com/?debug=old");
    expect((await state.port.readConflicts()).pending).toHaveLength(1);
  });

  it("reconciles managed addresses after global deactivation", async () => {
    const state = fake();
    await state.manager.add(rule);
    await state.manager.resolve(1, 1, "replace");
    state.setActive(false);
    expect(await state.manager.reconcile()).toEqual([]);
    expect(state.tab().url).toBe("https://example.com/?debug=old");
  });

  it("removes closed-tab conflicts and undo records", async () => {
    const state = fake();
    await state.manager.add(rule);
    await state.manager.forgetTab(1);
    expect(await state.port.readConflicts()).toEqual({ pending: [], ignored: [] });
  });

  it("allows reconciliation and disabling after site access is revoked", async () => {
    const state = fake();
    await state.manager.add(rule);
    state.port.permitted = async () => false;

    expect(await state.manager.reconcile()).toEqual([expect.stringMatching(/site access/i)]);
    expect(await state.manager.setEnabled(rule.id, false)).toEqual([]);
    expect((await state.port.read())[0].enabled).toBe(false);
  });

  it("reports inaccessible undo records without blocking reconciliation of other rules", async () => {
    const state = fake();
    await state.manager.add(rule);
    await state.manager.resolve(1, 1, "replace");
    state.setActive(false);
    state.port.permitted = async () => false;

    expect(await state.manager.reconcile()).toEqual([expect.stringMatching(/restore.*query/i)]);
  });
});
