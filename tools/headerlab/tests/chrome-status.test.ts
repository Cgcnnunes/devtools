import { afterEach, expect, it, vi } from "vitest";
import { readWarnings, updateStatus } from "../src/infrastructure/chrome-status.js";

afterEach(() => vi.unstubAllGlobals());

it("keeps a visible badge and warning for changed managed values", async () => {
  let stored: Record<string, unknown> = {};
  let badge = "";
  vi.stubGlobal("chrome", {
    storage: { session: {
      get: vi.fn(async (key: string) => ({ [key]: stored[key] })),
      set: vi.fn(async (items: Record<string, unknown>) => { stored = { ...stored, ...items }; }),
    } },
    action: { setBadgeText: vi.fn(async ({ text }: { text: string }) => { badge = text; }) },
  });
  await updateStatus(["A value changed; it was preserved."]);
  expect(await readWarnings()).toEqual(["A value changed; it was preserved."]);
  expect(badge).toBe("!");
});
