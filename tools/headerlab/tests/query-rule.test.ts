import { describe, expect, it } from "vitest";
import {
  applyQueryRule,
  addQueryRule,
  restoreQueryRule,
  type QueryRule,
} from "../src/domain/query-rule.js";

const rule: QueryRule = {
  id: 1, enabled: true, site: "example.com", includeSubdomains: false,
  protocols: ["https"], name: "debug", value: "on", operation: "set",
};

describe("query rules", () => {
  it("requests a decision before replacing existing values", () => {
    const url = "https://example.com/path?debug=old&debug=older&other=keep#fragment";
    const plan = applyQueryRule(rule, url);
    expect(plan.kind).toBe("conflict");
    const changed = applyQueryRule(rule, url, ["old", "older"]);
    expect(changed.kind).toBe("changed");
    if (changed.kind !== "changed") throw new Error("Expected a query change");
    expect(new URL(changed.url).searchParams.getAll("debug")).toEqual(["on"]);
    expect(new URL(changed.url).searchParams.get("other")).toBe("keep");
    expect(new URL(changed.url).hash).toBe("#fragment");
  });

  it("restores original values without discarding unrelated site changes", () => {
    const plan = applyQueryRule(rule, "https://example.com/?debug=old&debug=older", ["old", "older"]);
    if (plan.kind !== "changed") throw new Error("Expected a query change");
    const restored = restoreQueryRule(plan.undo, "https://example.com/?debug=on&other=site");
    expect(restored.kind).toBe("restored");
    if (restored.kind !== "restored") throw new Error("Expected restoration");
    const url = new URL(restored.url);
    expect(url.searchParams.getAll("debug")).toEqual(["old", "older"]);
    expect(url.searchParams.get("other")).toBe("site");
  });

  it("preserves values changed by the site", () => {
    const plan = applyQueryRule(rule, "https://example.com/?debug=old", ["old"]);
    if (plan.kind !== "changed") throw new Error("Expected a query change");
    expect(restoreQueryRule(plan.undo, "https://example.com/?debug=site")).toEqual({ kind: "changed-by-site" });
  });

  it("does not apply outside the selected host and scheme", () => {
    expect(applyQueryRule(rule, "https://api.example.com/").kind).toBe("unmatched");
    expect(applyQueryRule(rule, "http://example.com/").kind).toBe("unmatched");
    expect(applyQueryRule({ ...rule, includeSubdomains: true }, "https://api.example.com/").kind).toBe("changed");
    expect(applyQueryRule(rule, "https://example.com.evil.test/").kind).toBe("unmatched");
  });

  it("rejects a decision if the value changed after review", () => {
    expect(() => applyQueryRule(rule, "https://example.com/?debug=site-changed", ["old"])).toThrow(/changed/i);
  });

  it("rejects overlapping enabled query rules for the same parameter and scheme", () => {
    const parent = { ...rule, includeSubdomains: true };
    expect(() => addQueryRule([parent], { ...rule, id: 2, site: "api.example.com" })).toThrow(/overlap/i);
    expect(addQueryRule([parent], { ...rule, id: 2, site: "api.example.com", protocols: ["http"] })).toHaveLength(2);
    expect(addQueryRule([parent], { ...rule, id: 2, site: "api.example.com", enabled: false })).toHaveLength(2);
  });
});
