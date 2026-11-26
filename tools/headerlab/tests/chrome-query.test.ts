import { afterEach, expect, it, vi } from "vitest";
import { chromeQuery, queryTabIds, readQueryConflicts, readQueryRules } from "../src/infrastructure/chrome-query.js";

afterEach(() => vi.unstubAllGlobals());

it("preserves the journal when a live tab is not accessible", async () => {
  vi.stubGlobal("chrome", {
    tabs: { query: vi.fn().mockResolvedValue([{ id: 1 }]) },
    webNavigation: { getFrame: vi.fn() },
  });
  await expect(chromeQuery.tab(1)).rejects.toThrow(/access/i);
});

it("rejects invalid session undo data", async () => {
  vi.stubGlobal("chrome", {
    storage: { session: { get: vi.fn().mockResolvedValue({ queryUndo: [{ ruleId: 1 }] }) } },
  });
  await expect(chromeQuery.readUndo()).rejects.toThrow(/invalid/i);
});

it("rejects conflicting saved query rules", async () => {
  const rule = {
    id: 1, enabled: true, site: "example.com", includeSubdomains: true,
    protocols: ["https"], name: "debug", value: "on", operation: "set",
  };
  vi.stubGlobal("chrome", {
    storage: { local: { get: vi.fn().mockResolvedValue({
      queryRules: [rule, { ...rule, id: 2, site: "api.example.com" }],
    }) } },
  });
  await expect(readQueryRules()).rejects.toThrow(/saved query rules/i);
});

it("rejects invalid pending conflict data", async () => {
  vi.stubGlobal("chrome", {
    storage: { session: { get: vi.fn().mockResolvedValue({
      queryConflicts: { pending: [{ ruleId: 1, tab: { id: 1 }, values: ["old"] }], ignored: [] },
    }) } },
  });
  await expect(readQueryConflicts()).rejects.toThrow(/invalid/i);
});

it("selects only tabs within a rule's host and protocol", async () => {
  vi.stubGlobal("chrome", {
    tabs: { query: vi.fn().mockResolvedValue([
      { id: 1, url: "https://example.com/" },
      { id: 2, url: "http://example.com/" },
      { id: 3, url: "https://api.example.com/" },
      { id: 4, url: "https://example.com.evil.test/" },
      { id: 5 },
    ]) },
  });
  expect(await queryTabIds({
    id: 1, enabled: true, site: "example.com", includeSubdomains: true,
    protocols: ["https"], name: "debug", value: "on", operation: "set",
  })).toEqual([1, 3]);
});
