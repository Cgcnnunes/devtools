import { afterEach, describe, expect, it, vi } from "vitest";
import { chromeHeaders, readHeaderState } from "../src/infrastructure/chrome-headers.js";

afterEach(() => vi.unstubAllGlobals());

describe("Chrome header adapter", () => {
  it("reports invalid stored rules rather than discarding them", async () => {
    vi.stubGlobal("chrome", {
      storage: {
        local: {
          get: vi.fn().mockImplementation((key: string) =>
            Promise.resolve(key === "enabled" ? {} : { headerRules: [{ site: "bad" }] }),
          ),
        },
      },
    });
    await expect(readHeaderState()).rejects.toThrow("Saved header rules are invalid");
  });

  it("replaces installed rules using a destination-scoped header modification", async () => {
    const update = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal("chrome", {
      declarativeNetRequest: {
        getDynamicRules: vi.fn().mockResolvedValue([{ id: 8 }]),
        updateDynamicRules: update,
        HeaderOperation: { SET: "set", APPEND: "append", REMOVE: "remove" },
        RuleActionType: { MODIFY_HEADERS: "modifyHeaders" },
      },
    });
    await chromeHeaders.apply([{
      id: 1, enabled: true, site: "example.com", includeSubdomains: false,
      protocols: ["https"], name: "X-Test", operation: "set", value: "on",
    }]);
    expect(update).toHaveBeenCalledWith({
      removeRuleIds: [8],
      addRules: [{
        id: 1,
        action: { type: "modifyHeaders", requestHeaders: [{ header: "X-Test", operation: "set", value: "on" }] },
        condition: {
          regexFilter: "^https://example\\.com(?::[0-9]+)?/",
          resourceTypes: [
            "main_frame", "sub_frame", "stylesheet", "script", "image", "font", "object",
            "xmlhttprequest", "ping", "csp_report", "media", "websocket", "webtransport",
            "webbundle", "other",
          ],
        },
      }],
    });
  });
});
