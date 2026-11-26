import { describe, expect, it, vi } from "vitest";
import { HeaderEngine } from "../src/application/header-engine.js";
import type { HeaderRule } from "../src/domain/header-rule.js";

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

describe("header engine", () => {
  it("reconciles installed rules to the saved activation state after interruption", async () => {
    let installed = [rule];
    const adapter = {
      read: async () => ({ enabled: false, rules: [rule] }),
      write: vi.fn(),
      apply: async (rules: HeaderRule[]) => { installed = rules; },
    };

    await new HeaderEngine(adapter).reconcile();

    expect(installed).toEqual([]);
    expect(adapter.write).not.toHaveBeenCalled();
  });

  it("clears installed rules and reports an error if saved state cannot be read", async () => {
    let installed = [rule];
    const adapter = {
      read: async (): Promise<never> => { throw new Error("Cannot read rules"); },
      write: vi.fn(),
      apply: async (rules: HeaderRule[]) => { installed = rules; },
    };

    await expect(new HeaderEngine(adapter).reconcile()).rejects.toThrow("Cannot read rules");
    expect(installed).toEqual([]);
  });

  it("removes installed header rules when globally disabled", async () => {
    const adapter = {
      read: vi.fn().mockResolvedValue({ enabled: true, rules: [rule] }),
      write: vi.fn().mockResolvedValue(undefined),
      apply: vi.fn().mockResolvedValue(undefined),
    };
    await new HeaderEngine(adapter).setEnabled(false);
    expect(adapter.apply).toHaveBeenCalledWith([]);
    expect(adapter.write).toHaveBeenCalledWith({ enabled: false, rules: [rule] });
  });

  it("restores installed rules if saving the new state fails", async () => {
    const adapter = {
      read: vi.fn().mockResolvedValue({ enabled: true, rules: [] }),
      write: vi.fn().mockRejectedValue(new Error("Cannot save rules")),
      apply: vi.fn().mockResolvedValue(undefined),
    };
    await expect(new HeaderEngine(adapter).add(rule)).rejects.toThrow("Cannot save rules");
    expect(adapter.apply).toHaveBeenNthCalledWith(1, [rule]);
    expect(adapter.apply).toHaveBeenNthCalledWith(2, []);
  });

  it("rejects enabling an overlapping rule", async () => {
    const adapter = {
      read: vi.fn().mockResolvedValue({
        enabled: true,
        rules: [rule, { ...rule, id: 2, enabled: false }],
      }),
      write: vi.fn().mockResolvedValue(undefined),
      apply: vi.fn().mockResolvedValue(undefined),
    };
    await expect(new HeaderEngine(adapter).setRuleEnabled(2, true)).rejects.toThrow("overlaps");
    expect(adapter.apply).not.toHaveBeenCalled();
  });

  it("deletes a rule and removes it from the installed rules", async () => {
    const adapter = {
      read: vi.fn().mockResolvedValue({ enabled: true, rules: [rule] }),
      write: vi.fn().mockResolvedValue(undefined),
      apply: vi.fn().mockResolvedValue(undefined),
    };
    await new HeaderEngine(adapter).remove(1);
    expect(adapter.apply).toHaveBeenCalledWith([]);
    expect(adapter.write).toHaveBeenCalledWith({ enabled: true, rules: [] });
  });

  it("replaces an existing rule without duplicating it", async () => {
    const adapter = {
      read: vi.fn().mockResolvedValue({ enabled: true, rules: [rule] }),
      write: vi.fn().mockResolvedValue(undefined),
      apply: vi.fn().mockResolvedValue(undefined),
    };
    const updated = { ...rule, value: "changed" };
    await new HeaderEngine(adapter).update(updated);
    expect(adapter.write).toHaveBeenCalledWith({ enabled: true, rules: [updated] });
  });
});
