import { chromium, type BrowserContext } from "@playwright/test";
import { createServer } from "node:http";
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { expect, it } from "vitest";

it("loads as an extension and remembers the activation switch", async () => {
  const extensionPath = resolve("dist");
  const context = await chromium.launchPersistentContext("", {
    channel: "chromium",
    headless: true,
    args: [
      `--disable-extensions-except=${extensionPath}`,
      `--load-extension=${extensionPath}`,
    ],
  });

  try {
    const extensions = await context.newPage();
    await extensions.goto("chrome://extensions");
    const extension = extensions.locator("extensions-item").first();
    await extension.waitFor();
    const extensionId = await extension.getAttribute("id");
    if (!extensionId) throw new Error("HeaderLab was not loaded");

    const popup = await context.newPage();
    await popup.goto(`chrome-extension://${extensionId}/index.html`);
    const activation = popup.getByRole("checkbox", { name: "Activate" });
    await activation.waitFor({ state: "visible" });
    await expect.poll(() => activation.isEnabled()).toBe(true);
    expect(await activation.isChecked()).toBe(true);
    expect(await popup.getByText("Normal window").count()).toBe(1);
    expect(await popup.getByText("v0.5.0").count()).toBe(1);

    await activation.uncheck();
    await expect.poll(() => activation.isEnabled()).toBe(true);

    const secondPopup = await context.newPage();
    await secondPopup.goto(`chrome-extension://${extensionId}/index.html`);
    const secondActivation = secondPopup.getByRole("checkbox", { name: "Activate" });
    await expect.poll(() => secondActivation.isEnabled()).toBe(true);
    expect(await secondActivation.isChecked()).toBe(false);
    await secondActivation.check();
    await expect.poll(() => activation.isChecked()).toBe(true);
    await expect.poll(() => secondActivation.isEnabled()).toBe(true);
    await secondActivation.uncheck();
    await expect.poll(() => activation.isChecked()).toBe(false);
    await expect.poll(() => secondActivation.isEnabled()).toBe(true);
    await secondPopup.close();

    const worker = context.serviceWorkers()[0] ?? await context.waitForEvent("serviceworker");
    await worker.evaluate(async () => {
      await chrome.declarativeNetRequest.updateDynamicRules({
        addRules: [{
          id: 1,
          action: {
            type: chrome.declarativeNetRequest.RuleActionType.MODIFY_HEADERS,
            requestHeaders: [{ header: "X-Test", operation: chrome.declarativeNetRequest.HeaderOperation.SET, value: "stale" }],
          },
          condition: { urlFilter: "example.com" },
        }],
      });
    });
    const cdp = await context.newCDPSession(popup);
    const { targetInfos } = await cdp.send("Target.getTargets");
    const target = targetInfos.find((info) => info.type === "service_worker" && info.url === worker.url());
    if (!target) throw new Error("HeaderLab service worker was not found");
    const result = await cdp.send("Target.closeTarget", { targetId: target.targetId });
    expect(result.success).toBe(true);
    await popup.reload();
    await expect.poll(() => activation.isEnabled()).toBe(true);
    expect(await activation.isChecked()).toBe(false);
    expect(await worker.evaluate(() => chrome.declarativeNetRequest.getDynamicRules())).toEqual([]);

    await popup.evaluate(() => {
      Object.defineProperty(chrome.storage.local, "get", {
        value: async () => { throw new Error("Cannot read saved state"); },
      });
    });
    await activation.check();
    await expect.poll(() => popup.getByRole("alert").textContent()).toContain("Cannot read saved state");
    expect(await activation.isEnabled()).toBe(false);
    expect(await popup.getByRole("button", { name: "Add header" }).isEnabled()).toBe(false);
  } finally {
    await context.close();
  }
}, 30_000);

it("applies, edits, disables and deletes a destination-scoped header", async () => {
  const incognitoRequests: (string | string[] | undefined)[] = [];
  const server = createServer((request, response) => {
    if (request.url === "/incognito") incognitoRequests.push(request.headers["x-headerlab-test"]);
    response.setHeader("content-type", "application/json");
    response.setHeader("cache-control", "no-store");
    response.end(JSON.stringify({ value: request.headers["x-headerlab-test"] ?? null }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Test server did not start");
  const extensionPath = mkdtempSync(join(tmpdir(), "headerlab-browser-test-"));
  let context: BrowserContext | undefined;
  try {
    cpSync(resolve("dist"), extensionPath, { recursive: true });
    const manifestPath = join(extensionPath, "manifest.json");
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
    // Headless Chromium cannot approve the optional host permission dialog.
    manifest.host_permissions = ["http://127.0.0.1/*", "http://localhost/*"];
    writeFileSync(manifestPath, JSON.stringify(manifest));
    context = await chromium.launchPersistentContext("", {
      channel: "chromium",
      headless: true,
      args: [
        `--disable-extensions-except=${extensionPath}`,
        `--load-extension=${extensionPath}`,
      ],
    });
    const extensions = await context.newPage();
    await extensions.goto("chrome://extensions");
    await extensions.locator("#devMode").click();
    const extension = extensions.locator("extensions-item").first();
    await extension.waitFor();
    const extensionId = await extension.getAttribute("id");
    if (!extensionId) throw new Error("HeaderLab was not loaded");
    await extension.locator("#detailsButton").click();
    const incognito = extensions.locator("#allow-incognito cr-toggle");
    await incognito.click();
    await expect.poll(() => incognito.getAttribute("aria-checked")).toBe("true");

    const popup = await context.newPage();
    await popup.goto(`chrome-extension://${extensionId}/index.html`);
    await expect.poll(() => popup.getByRole("button", { name: "Add header" }).isEnabled()).toBe(true);
    await popup.getByLabel("Header name").fill("X-HeaderLab-Test");
    await popup.getByLabel("Value", { exact: true }).fill("active");
    await popup.getByLabel("Site", { exact: true }).fill("127.0.0.1");
    await popup.getByLabel("HTTPS").uncheck();
    await popup.getByLabel("HTTP", { exact: true }).check();
    await popup.getByRole("button", { name: "Add header" }).click();
    await expect.poll(async () => {
      const alert = popup.getByRole("alert");
      if (await alert.isVisible()) throw new Error(await alert.textContent() ?? "Unknown popup error");
      return popup.getByText("X-HeaderLab-Test", { exact: true }).count();
    }).toBe(1);

    const page = await context.newPage();
    await page.goto(`http://127.0.0.1:${address.port}/`);
    expect(await page.locator("body").textContent()).toContain('"value":"active"');
    expect(await page.evaluate(async () => (await fetch("/")).json())).toEqual({ value: "active" });
    expect(await popup.evaluate(() => chrome.extension.isAllowedIncognitoAccess())).toBe(true);
    const incognitoTabId = await popup.evaluate(async (url) => {
      const window = await chrome.windows.create({ incognito: true, url });
      return window?.tabs?.[0]?.id;
    }, `http://127.0.0.1:${address.port}/incognito`);
    if (incognitoTabId === undefined) throw new Error("Incognito tab was not created");
    await expect.poll(() => incognitoRequests.length).toBe(1);
    expect(incognitoRequests[0]).toBe("active");
    await page.goto(`http://localhost:${address.port}/`);
    expect(await page.locator("body").textContent()).toContain('"value":null');
    await page.bringToFront();
    await popup.getByLabel("Site", { exact: true }).fill("old.example");
    await popup.getByRole("button", { name: "Detect" }).click();
    await expect.poll(() => popup.getByLabel("Site", { exact: true }).inputValue()).toBe("localhost");

    await popup.getByRole("button", { name: "Edit" }).click();
    await popup.getByLabel("Value", { exact: true }).fill("updated");
    await popup.getByRole("button", { name: "Save header" }).click();
    await expect.poll(() => popup.getByRole("button", { name: "Add header" }).isEnabled()).toBe(true);
    await page.goto(`http://127.0.0.1:${address.port}/`);
    expect(await page.locator("body").textContent()).toContain('"value":"updated"');

    const ruleToggle = popup.getByRole("checkbox", { name: "Enable X-HeaderLab-Test for 127.0.0.1" });
    await ruleToggle.uncheck();
    await expect.poll(() => popup.getByRole("button", { name: "Add header" }).isEnabled()).toBe(true);
    await page.reload();
    expect(await page.locator("body").textContent()).toContain('"value":null');
    await popup.evaluate((tabId) => chrome.tabs.reload(tabId), incognitoTabId);
    await expect.poll(() => incognitoRequests.length).toBe(2);
    expect(incognitoRequests[1]).toBeUndefined();
    await ruleToggle.check();
    await expect.poll(() => popup.getByRole("button", { name: "Add header" }).isEnabled()).toBe(true);
    await page.reload();
    expect(await page.locator("body").textContent()).toContain('"value":"updated"');

    const activation = popup.getByRole("checkbox", { name: "Activate" });
    await activation.uncheck();
    await expect.poll(() => activation.isEnabled()).toBe(true);
    await page.reload();
    expect(await page.locator("body").textContent()).toContain('"value":null');
    await popup.evaluate((tabId) => chrome.tabs.reload(tabId), incognitoTabId);
    await expect.poll(() => incognitoRequests.length).toBe(3);
    expect(incognitoRequests[2]).toBeUndefined();
    await activation.check();
    await expect.poll(() => activation.isEnabled()).toBe(true);
    await popup.getByRole("button", { name: "Delete" }).click();
    await expect.poll(() => popup.getByText("No rules yet.").isVisible()).toBe(true);
    await page.reload();
    expect(await page.locator("body").textContent()).toContain('"value":null');

    await popup.evaluate(() => {
      Object.defineProperty(chrome.permissions, "request", { value: async () => false });
    });
    await popup.getByLabel("Header name").fill("X-Denied");
    await popup.getByLabel("Site", { exact: true }).fill("example.com");
    await popup.getByRole("button", { name: "Add header" }).click();
    await expect.poll(() => popup.getByRole("alert").textContent()).toContain("Site access was not granted.");
    expect(await popup.getByText("No rules yet.").isVisible()).toBe(true);

    await popup.evaluate(() => {
      Object.defineProperty(chrome.runtime, "sendMessage", {
        value: async () => ({ ok: false, error: "Cannot reconcile header rules" }),
      });
    });
    await activation.click();
    await expect.poll(() => popup.getByRole("alert").textContent()).toContain("Cannot reconcile header rules");
    expect(await activation.isEnabled()).toBe(false);
    expect(await popup.getByRole("button", { name: "Add header" }).isEnabled()).toBe(false);
  } finally {
    try {
      await context?.close();
    } finally {
      rmSync(extensionPath, { recursive: true });
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
  }
}, 30_000);
