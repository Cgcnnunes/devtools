import { describe, expect, it } from "vitest";
import {
  headerRulesOverlap,
  addHeaderRule,
  networkRule,
  requestPattern,
  validateHeaderRule,
  type HeaderRule,
} from "../src/domain/header-rule.js";

const rule: HeaderRule = {
  id: 1,
  enabled: true,
  site: "example.com",
  includeSubdomains: false,
  protocols: ["https"],
  name: "X-Debug",
  operation: "set",
  value: "enabled",
};

describe("header rules", () => {
  it("matches the destination host and chosen protocol without leaking to lookalike domains", () => {
    const pattern = new RegExp(requestPattern(rule));
    expect(pattern.test("https://example.com/path")).toBe(true);
    expect(pattern.test("https://example.com:8443/path")).toBe(true);
    expect(pattern.test("http://example.com/path")).toBe(false);
    expect(pattern.test("https://api.example.com/path")).toBe(false);
    expect(pattern.test("https://example.com.attacker.test/path")).toBe(false);
    expect(pattern.test("https://attacker.test/?url=example.com")).toBe(false);
  });

  it("includes subdomains only when explicitly selected", () => {
    const pattern = new RegExp(requestPattern({ ...rule, includeSubdomains: true }));
    expect(pattern.test("https://example.com/")).toBe(true);
    expect(pattern.test("https://api.example.com/")).toBe(true);
    expect(pattern.test("https://notexample.com/")).toBe(false);
  });

  it("rejects malformed hosts and header injection", () => {
    expect(validateHeaderRule({ ...rule, site: "example.com.evil/path" })).toBeTruthy();
    expect(validateHeaderRule({ ...rule, name: "X-Test\r\nInjected" })).toBeTruthy();
    expect(validateHeaderRule({ ...rule, value: "x\r\nInjected: y" })).toBeTruthy();
    expect(validateHeaderRule({ ...rule, protocols: [] })).toBeTruthy();
  });

  it("rejects append for headers Chrome cannot append", () => {
    expect(validateHeaderRule({ ...rule, operation: "append" })).toMatch(/append/i);
    expect(validateHeaderRule({ ...rule, name: "accept-language", operation: "append" })).toBeNull();
  });

  it("detects overlapping header rules regardless of header-name case", () => {
    expect(headerRulesOverlap(rule, {
      ...rule, id: 2, site: "api.example.com", name: "x-debug",
    })).toBe(false);
    expect(headerRulesOverlap({ ...rule, includeSubdomains: true }, {
      ...rule, id: 2, site: "api.example.com", name: "x-debug",
    })).toBe(true);
    expect(headerRulesOverlap(rule, { ...rule, id: 2, protocols: ["http"] })).toBe(false);
  });

  it("creates a request-header modification scoped to the destination", () => {
    const result = networkRule(rule);
    expect(result.id).toBe(1);
    expect(result.action).toEqual({
      type: "modifyHeaders",
      requestHeaders: [{ header: "X-Debug", operation: "set", value: "enabled" }],
    });
    expect(result.condition.regexFilter).toBe(requestPattern(rule));
  });

  it("does not include a value when removing a header", () => {
    expect(networkRule({ ...rule, operation: "remove" }).action.requestHeaders).toEqual([
      { header: "X-Debug", operation: "remove" },
    ]);
  });

  it("rejects overlapping enabled rules rather than choosing an order", () => {
    expect(() => addHeaderRule([rule], { ...rule, id: 2, name: "x-debug" }))
      .toThrow("overlaps");
    expect(addHeaderRule([rule], { ...rule, id: 2, enabled: false })).toHaveLength(2);
  });
});
