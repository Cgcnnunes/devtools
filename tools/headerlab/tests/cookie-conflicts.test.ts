import { afterEach, expect, it, vi } from "vitest";
import { pruneCookieConflicts, readCookieConflicts, writeCookieConflict } from "../src/infrastructure/chrome-cookie-conflicts.js";

afterEach(() => vi.unstubAllGlobals());

it("keeps cookie conflict decisions in session storage", async () => {
  let state: Record<string, unknown> = {};
  vi.stubGlobal("chrome", {
    storage: { session: {
      get: vi.fn(async (key: string) => ({ [key]: state[key] })),
      set: vi.fn(async (items: Record<string, unknown>) => { state = { ...state, ...items }; }),
    } },
  });
  const cookie: chrome.cookies.Cookie = {
    name: "test", value: "old", domain: "example.com", path: "/", storeId: "0",
    hostOnly: true, session: true, secure: true, httpOnly: false, sameSite: "lax",
  };
  await writeCookieConflict(1, [cookie]);
  const [first] = await readCookieConflicts();
  expect(first).toEqual({ ruleId: 1, cookies: [cookie], revision: expect.any(String) });
  await writeCookieConflict(1, [cookie]);
  expect((await readCookieConflicts())[0].revision).toBe(first.revision);
  await writeCookieConflict(1, [{ ...cookie, value: "changed" }]);
  expect((await readCookieConflicts())[0].revision).not.toBe(first.revision);
  await pruneCookieConflicts([]);
  expect(await readCookieConflicts()).toEqual([]);
  await writeCookieConflict(1, [cookie]);
  await writeCookieConflict(1, []);
  expect(await readCookieConflicts()).toEqual([]);
});
