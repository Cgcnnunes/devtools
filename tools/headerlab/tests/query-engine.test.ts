import { describe, expect, it } from "vitest";
import { QueryEngine, type QueryPort, type QueryRecord, type QueryTab } from "../src/application/query-engine.js";
import type { QueryRule } from "../src/domain/query-rule.js";

const rule: QueryRule = {
  id: 1, enabled: true, site: "example.com", includeSubdomains: false,
  protocols: ["https"], name: "debug", value: "on", operation: "set",
};

function fake(initialUrl: string) {
  let tab: QueryTab | undefined = { id: 1, documentId: "document-1", url: initialUrl };
  let records: QueryRecord[] = [];
  const port: QueryPort = {
    tab: async () => tab && structuredClone(tab),
    readUndo: async () => structuredClone(records),
    writeUndo: async (entries) => { records = structuredClone(entries); },
    replace: async (expected, next) => {
      if (!tab || tab.documentId !== expected.documentId || tab.url !== expected.url) return false;
      tab = { ...tab, url: next };
      return true;
    },
  };
  return {
    port,
    setTab: (next: QueryTab | undefined) => { tab = next; },
  };
}

describe("query engine", () => {
  it("applies without navigating and safely restores an approved value", async () => {
    const state = fake("https://example.com/?debug=old");
    const engine = new QueryEngine(state.port);
    const plan = await engine.apply(rule, 1);
    expect(plan).toEqual({
      kind: "conflict", values: ["old"],
      tab: { id: 1, documentId: "document-1", url: "https://example.com/?debug=old" },
    });
    expect(await engine.apply(rule, 1, { documentId: "document-1", values: ["old"] })).toEqual({ kind: "applied" });
    expect((await state.port.tab(1))?.url).toBe("https://example.com/?debug=on");
    expect(await engine.undo(rule.id)).toEqual([]);
    expect((await state.port.tab(1))?.url).toBe("https://example.com/?debug=old");
  });

  it("preserves an address changed by the site", async () => {
    const state = fake("https://example.com/?debug=old");
    const engine = new QueryEngine(state.port);
    await engine.apply(rule, 1, { documentId: "document-1", values: ["old"] });
    state.setTab({ id: 1, documentId: "document-1", url: "https://example.com/?debug=site" });
    expect(await engine.apply(rule, 1)).toEqual({ kind: "warning", message: expect.stringMatching(/preserved/i) });
    expect(await engine.undo(rule.id)).toHaveLength(1);
    expect((await state.port.tab(1))?.url).toBe("https://example.com/?debug=site");
  });

  it("never restores into a later document in the same tab", async () => {
    const state = fake("https://example.com/?debug=old");
    const engine = new QueryEngine(state.port);
    await engine.apply(rule, 1, { documentId: "document-1", values: ["old"] });
    state.setTab({ id: 1, documentId: "document-2", url: "https://example.com/?debug=on" });
    expect(await engine.undo(rule.id)).toEqual([]);
    expect((await state.port.tab(1))?.url).toBe("https://example.com/?debug=on");
    expect(await state.port.readUndo()).toEqual([]);
  });

  it("is idempotent while its managed value is unchanged", async () => {
    const state = fake("https://example.com/");
    const engine = new QueryEngine(state.port);
    expect(await engine.apply(rule, 1)).toEqual({ kind: "applied" });
    expect(await engine.apply(rule, 1)).toEqual({ kind: "unchanged" });
    expect(await state.port.readUndo()).toHaveLength(1);
  });

  it("cleans up an interrupted undo when the original values are already present", async () => {
    const state = fake("https://example.com/?debug=old");
    const engine = new QueryEngine(state.port);
    await engine.apply(rule, 1, { documentId: "document-1", values: ["old"] });
    state.setTab({ id: 1, documentId: "document-1", url: "https://example.com/?debug=old" });
    expect(await engine.undo(rule.id)).toEqual([]);
    expect(await state.port.readUndo()).toEqual([]);
  });

  it("refuses approval for a different document even if the value is identical", async () => {
    const state = fake("https://example.com/?debug=old");
    const engine = new QueryEngine(state.port);
    state.setTab({ id: 1, documentId: "document-2", url: "https://example.com/?debug=old" });
    await expect(engine.apply(rule, 1, { documentId: "document-1", values: ["old"] })).rejects.toThrow(/document/i);
    expect(await state.port.readUndo()).toEqual([]);
  });

  it("discards undo records when a tab closes", async () => {
    const state = fake("https://example.com/?debug=old");
    const engine = new QueryEngine(state.port);
    await engine.apply(rule, 1, { documentId: "document-1", values: ["old"] });
    state.setTab(undefined);
    await engine.forgetTab(1);
    expect(await state.port.readUndo()).toEqual([]);
  });
});
