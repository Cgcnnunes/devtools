import { chromium } from "@playwright/test";
import { createServer } from "vite";
import { expect, it } from "vitest";

it("uses the real popup with an isolated interactive browser simulation", async () => {
  const server = await createServer({ server: { host: "127.0.0.1", port: 0 }, logLevel: "silent" });
  await server.listen();
  const address = server.httpServer?.address();
  if (!address || typeof address === "string") throw new Error("Preview server did not start");
  const browser = await chromium.launch({ channel: "chromium", headless: true });
  try {
    const context = await browser.newContext();
    const page = await context.newPage();
    await page.goto(`http://127.0.0.1:${address.port}/`);
    await expect.poll(() => page.getByRole("checkbox", { name: "Activate" }).isEnabled()).toBe(true);
    expect(await page.getByText("Interactive simulation", { exact: false }).count()).toBeGreaterThan(0);
    expect(await page.locator(".popup").evaluate((popup) => popup.contains(document.querySelector("#preview")))).toBe(false);
    const popupSize = await page.locator(".popup").evaluate((popup) => ({
      width: popup.getBoundingClientRect().width, maxHeight: getComputedStyle(popup).maxHeight,
    }));
    expect(popupSize).toEqual({ width: 528, maxHeight: "600px" });
    await page.getByLabel("Simulated address").fill("https://sub.example.test:8443/path");
    await page.getByRole("button", { name: "Load simulated address" }).click();
    await expect.poll(() => page.locator("#preview-tabs").textContent()).toContain("sub.example.test");
    await page.getByLabel("Site", { exact: true }).fill("old.example");
    await page.getByRole("button", { name: "Detect" }).click();
    expect(await page.getByLabel("Site", { exact: true }).inputValue()).toBe("sub.example.test");
    for (const kind of ["cookie", "query"]) {
      await page.getByLabel("Type").selectOption(kind);
      await page.getByLabel("Site", { exact: true }).fill("old.example");
      await page.getByRole("button", { name: "Detect" }).click();
      expect(await page.getByLabel("Site", { exact: true }).inputValue()).toBe("sub.example.test");
    }
    await page.getByLabel("Site", { exact: true }).fill("keep.example");
    await page.evaluate(() => {
      const query = chrome.tabs.query.bind(chrome.tabs);
      Object.defineProperty(chrome.tabs, "query", {
        configurable: true,
        value: (options: chrome.tabs.QueryInfo) =>
          options.active ? Promise.resolve([{ url: "chrome://extensions" }]) : query(options),
      });
    });
    await page.getByRole("button", { name: "Detect" }).click();
    await expect.poll(() => page.getByRole("alert").textContent()).toMatch(/HTTP|website/i);
    expect(await page.getByLabel("Site", { exact: true }).inputValue()).toBe("keep.example");
    await page.reload();
    await expect.poll(() => page.getByRole("checkbox", { name: "Activate" }).isEnabled()).toBe(true);
    const type = page.getByLabel("Type");
    await type.focus();
    await page.keyboard.press("Space");
    await page.keyboard.press("ArrowDown");
    await page.keyboard.press("Enter");
    expect(await type.inputValue()).toBe("cookie");
    await type.selectOption("header");
    await page.getByLabel("Header name").fill("X-Demo");
    await page.getByLabel("Value", { exact: true }).fill("on");
    await page.getByLabel("Site", { exact: true }).fill("example.com");
    const headerColor = await page.getByRole("button", { name: "Add header" })
      .evaluate((button) => getComputedStyle(button).backgroundColor);
    await page.getByRole("button", { name: "Add header" }).click();
    await expect.poll(() => page.locator("#preview-headers").textContent()).toContain("X-Demo");
    const headerToggle = page.getByRole("checkbox", { name: "Enable X-Demo for example.com" });
    expect(await headerToggle.evaluate((input) => getComputedStyle(input).accentColor)).toBe(headerColor);
    const headerRow = headerToggle.locator("..").locator("..");
    const editStyle = await headerRow.getByRole("button", { name: "Edit" })
      .evaluate((button) => ({ color: getComputedStyle(button).color, background: getComputedStyle(button).backgroundColor }));
    const deleteStyle = await headerRow.getByRole("button", { name: "Delete" })
      .evaluate((button) => ({ color: getComputedStyle(button).color, background: getComputedStyle(button).backgroundColor }));
    expect(editStyle.color).toBe(deleteStyle.color);
    expect(editStyle.background).not.toBe(deleteStyle.background);
    expect(editStyle.background).not.toBe(headerColor);
    const editRgb = editStyle.background.match(/\d+/g)?.map(Number);
    const deleteRgb = deleteStyle.background.match(/\d+/g)?.map(Number);
    expect(editRgb).toBeDefined();
    expect(deleteRgb).toBeDefined();
    expect(editRgb?.[0]).toBe(editRgb?.[1]);
    expect(editRgb?.[1]).toBe(editRgb?.[2]);
    expect(deleteRgb?.[0]).toBeGreaterThan(deleteRgb?.[1] ?? Infinity);
    expect(deleteRgb?.[0]).toBeGreaterThan(deleteRgb?.[2] ?? Infinity);
    const headerTooltip = headerRow.getByRole("tooltip", { includeHidden: true });
    expect(await headerTooltip.isVisible()).toBe(false);
    expect(await headerRow.innerText()).not.toContain("example.com");
    await headerRow.getByText("X-Demo", { exact: true }).focus();
    expect(await headerTooltip.isVisible()).toBe(true);
    expect(await headerTooltip.textContent()).toContain("example.com");
    expect(await headerTooltip.textContent()).toContain("Set");
    const tipBounds = await headerTooltip.boundingBox();
    const popupBounds = await page.locator(".popup").boundingBox();
    if (!tipBounds || !popupBounds) throw new Error("Tooltip or popup is not visible");
    expect(tipBounds.y).toBeGreaterThanOrEqual(popupBounds.y);
    expect(tipBounds.y + tipBounds.height).toBeLessThanOrEqual(popupBounds.y + popupBounds.height);
    await page.keyboard.press("Escape");
    expect(await headerTooltip.isVisible()).toBe(false);
    await page.getByLabel("Header name").fill("X-Another");
    await page.getByLabel("Value", { exact: true }).fill("two");
    await page.getByLabel("Site", { exact: true }).fill("example.com");
    await page.getByRole("button", { name: "Add header" }).click();
    const headerGroup = page.getByRole("checkbox", { name: "Enable all headers" });
    const secondHeader = page.getByRole("checkbox", { name: "Enable X-Another for example.com" });
    await expect.poll(() => headerGroup.isChecked()).toBe(true);
    await secondHeader.uncheck();
    await expect.poll(() => headerGroup.evaluate((input: HTMLInputElement) => input.indeterminate)).toBe(true);
    await headerGroup.check();
    await expect.poll(() => secondHeader.isChecked()).toBe(true);
    await headerGroup.uncheck();
    await expect.poll(() => headerToggle.isChecked()).toBe(false);
    await expect.poll(() => secondHeader.isChecked()).toBe(false);
    await headerGroup.check();
    await expect.poll(() => headerToggle.isChecked()).toBe(true);
    await page.evaluate(() => {
      const send = chrome.runtime.sendMessage.bind(chrome.runtime);
      let updates = 0;
      Object.defineProperty(chrome.runtime, "sendMessage", {
        configurable: true,
        value: (message: { type?: string }) => {
          if (message.type === "toggle-header" && ++updates === 2) {
            return Promise.resolve({ ok: false, error: "Simulated failure." });
          }
          return send(message);
        },
      });
    });
    await headerGroup.uncheck();
    await expect.poll(() => page.getByRole("alert").textContent()).toContain("some may have changed");
    await expect.poll(() => headerToggle.isChecked()).toBe(false);
    await expect.poll(() => secondHeader.isChecked()).toBe(true);
    await expect.poll(() => headerGroup.evaluate((input: HTMLInputElement) => input.indeterminate)).toBe(true);
    await headerGroup.check();
    await expect.poll(() => headerToggle.isChecked()).toBe(true);
    await page.getByLabel("Type").selectOption("query");
    const queryColor = await page.getByRole("button", { name: "Add parameter" })
      .evaluate((button) => getComputedStyle(button).backgroundColor);
    expect(queryColor).not.toBe(headerColor);
    await page.getByLabel("Parameter name").fill("debug");
    await page.getByLabel("Value", { exact: true }).fill("on");
    await page.getByLabel("Site", { exact: true }).fill("example.com");
    await page.getByRole("button", { name: "Add parameter" }).click();
    await expect.poll(() => page.locator("#preview-tabs").textContent()).toContain("debug=on");
    const queryToggle = page.getByRole("checkbox", { name: "Enable query debug for example.com" });
    expect(await queryToggle.evaluate((input) => getComputedStyle(input).accentColor)).toBe(queryColor);
    expect(await queryToggle.locator("..").locator("..").getByRole("tooltip", { includeHidden: true }).count()).toBe(0);
    expect(await queryToggle.locator("..").locator("..").innerText()).not.toContain("example.com");
    await expect.poll(() => page.getByRole("checkbox", { name: "Enable all query parameters" }).isChecked()).toBe(true);
    await page.getByLabel("Type").selectOption("cookie");
    const cookieColor = await page.getByRole("button", { name: "Add cookie" })
      .evaluate((button) => getComputedStyle(button).backgroundColor);
    expect(new Set([headerColor, queryColor, cookieColor]).size).toBe(3);
    await page.getByLabel("Cookie name", { exact: true }).fill("example");
    await page.getByLabel("Value", { exact: true }).fill("demo");
    await page.getByLabel("Site", { exact: true }).fill("example.com");
    await page.getByRole("button", { name: "Add cookie" }).click();
    await expect.poll(() => page.locator("#preview-cookies").textContent()).toContain("example=demo");
    const cookieToggleColor = await page.getByRole("checkbox", { name: "Enable cookie example for example.com" })
      .evaluate((input) => getComputedStyle(input).accentColor);
    expect(cookieToggleColor).toBe(cookieColor);
    const cookieRow = page.getByRole("checkbox", { name: "Enable cookie example for example.com" })
      .locator("..").locator("..");
    await cookieRow.getByText("example", { exact: true }).hover();
    const cookieTooltip = cookieRow.getByRole("tooltip");
    expect(await cookieTooltip.isVisible()).toBe(true);
    expect(await cookieTooltip.textContent()).toContain("example.com");
    expect(await cookieTooltip.textContent()).toContain("SameSite");
    const cookieGroup = page.getByRole("checkbox", { name: "Enable all cookies" });
    await expect.poll(() => cookieGroup.isChecked()).toBe(true);
    await cookieGroup.uncheck();
    await expect.poll(() => page.locator("#preview-cookies").textContent()).not.toContain("example=demo");
    await cookieGroup.check();
    await expect.poll(() => page.locator("#preview-cookies").textContent()).toContain("example=demo");
    const queryGroup = page.getByRole("checkbox", { name: "Enable all query parameters" });
    await queryGroup.uncheck();
    await expect.poll(() => page.locator("#preview-tabs").textContent()).not.toContain("debug=on");
    await queryGroup.check();
    await expect.poll(() => page.locator("#preview-tabs").textContent()).toContain("debug=on");
    expect(await context.cookies()).toEqual([]);

    await page.reload();
    await expect.poll(() => page.getByRole("checkbox", { name: "Activate" }).isEnabled()).toBe(true);
    await expect.poll(() => page.getByText("No rules yet.").isVisible()).toBe(true);
    await expect.poll(() => page.locator("#preview-cookies").textContent()).toBe("");
    await page.getByLabel("Site cookie name").fill("existing");
    await page.getByLabel("Site cookie value").fill("original");
    await page.getByRole("button", { name: "Set simulated site cookie" }).click();
    await expect.poll(() => page.locator("#preview-cookies").textContent()).toContain("existing=original");
    await page.getByLabel("Type").selectOption("cookie");
    await page.getByLabel("Cookie name", { exact: true }).fill("existing");
    await page.getByLabel("Value", { exact: true }).fill("managed");
    await page.getByLabel("Site", { exact: true }).fill("example.com");
    await page.getByLabel("Secure").uncheck();
    await page.getByRole("button", { name: "Add cookie" }).click();
    await expect.poll(() => page.getByText("Cookie conflict", { exact: true }).isVisible()).toBe(true);
    await page.getByRole("button", { name: "Keep cookies and disable rule" }).click();
    const cookieToggle = page.getByRole("checkbox", { name: "Enable cookie existing for example.com" });
    await expect.poll(() => cookieToggle.isChecked()).toBe(false);
    await expect.poll(() => page.locator("#preview-cookies").textContent()).toContain("existing=original");
    await cookieToggle.check();
    await expect.poll(() => page.getByText("Cookie conflict", { exact: true }).isVisible()).toBe(true);
    await page.getByRole("button", { name: "Replace cookies" }).click();
    await expect.poll(() => page.locator("#preview-cookies").textContent()).toContain("existing=managed");
    await page.getByRole("checkbox", { name: "Activate" }).uncheck();
    await expect.poll(() => page.locator("#preview-cookies").textContent()).toContain("existing=original");
    await page.getByRole("checkbox", { name: "Activate" }).check();
    await expect.poll(() => page.getByText("Cookie conflict", { exact: true }).isVisible()).toBe(true);
    await page.getByRole("button", { name: "Replace cookies" }).click();
    await expect.poll(() => page.locator("#preview-cookies").textContent()).toContain("existing=managed");
    await page.getByLabel("Site cookie value").fill("site-changed");
    await page.getByRole("button", { name: "Set simulated site cookie" }).click();
    await page.getByRole("checkbox", { name: "Activate" }).uncheck();
    await expect.poll(() => page.locator("#warnings-list").textContent()).toContain("preserved");
    await expect.poll(() => page.locator("#preview-cookies").textContent()).toContain("existing=site-changed");
    expect(await context.cookies()).toEqual([]);
    await context.close();
  } finally {
    await browser.close();
    await server.close();
  }
}, 30_000);
