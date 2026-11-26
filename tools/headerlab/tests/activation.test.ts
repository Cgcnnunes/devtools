import { describe, expect, it, vi } from "vitest";
import { getActivation, setActivation } from "../src/application/activation.js";

describe("shared activation", () => {
  it("starts enabled when no setting exists", async () => {
    const storage = { get: vi.fn().mockResolvedValue({}), set: vi.fn() };
    await expect(getActivation(storage)).resolves.toBe(true);
  });

  it("restores a saved disabled setting", async () => {
    const storage = { get: vi.fn().mockResolvedValue({ enabled: false }), set: vi.fn() };
    await expect(getActivation(storage)).resolves.toBe(false);
  });

  it("saves changes in shared local storage", async () => {
    const storage = { get: vi.fn(), set: vi.fn().mockResolvedValue(undefined) };
    await setActivation(storage, false);
    expect(storage.set).toHaveBeenCalledWith({ enabled: false });
  });

  it("reports invalid stored values instead of silently enabling the extension", async () => {
    const storage = { get: vi.fn().mockResolvedValue({ enabled: "yes" }), set: vi.fn() };
    await expect(getActivation(storage)).rejects.toThrow("Invalid activation setting");
  });

  it("surfaces storage failures", async () => {
    const storage = { get: vi.fn().mockRejectedValue(new Error("Storage unavailable")), set: vi.fn() };
    await expect(getActivation(storage)).rejects.toThrow("Storage unavailable");
  });
});
