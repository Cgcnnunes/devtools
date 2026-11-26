import { chromium } from "@playwright/test";
import { createServer } from "node:http";
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { expect, it } from "vitest";

it("applies cookie and query rules to new incognito windows", async () => {
  const server = createServer((_request, response) => response.end("ready"));
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Test server did not start");
  const extensionPath = mkdtempSync(join(tmpdir(), "headerlab-incognito-test-"));
  const profilePath = mkdtempSync(join(tmpdir(), "headerlab-incognito-profile-"));
  try {
    cpSync(resolve("dist"), extensionPath, { recursive: true });
    const manifestPath = join(extensionPath, "manifest.json");
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
    manifest.host_permissions = ["http://127.0.0.1/*", "https://127.0.0.1/*"];
    writeFileSync(manifestPath, JSON.stringify(manifest));
    const options = {
      channel: "chromium", headless: true,
      args: [`--disable-extensions-except=${extensionPath}`, `--load-extension=${extensionPath}`],
    };
    let context = await chromium.launchPersistentContext(profilePath, options);
    try {
      const worker = context.serviceWorkers()[0] ?? await context.waitForEvent("serviceworker");
      const extensionId = new URL(worker.url()).hostname;
      const settings = await context.newPage();
      settings.setDefaultTimeout(5000);
      await settings.goto(`chrome://extensions/?id=${extensionId}`);
      await settings.getByText("Developer mode", { exact: true }).click();
      await settings.getByText("Allow in Incognito", { exact: true }).click({ timeout: 5000 });
      await context.close();
      context = await chromium.launchPersistentContext(profilePath, options);
      const popup = await context.newPage();
      await expect.poll(async () => {
        try {
          await popup.goto(`chrome-extension://${extensionId}/index.html`);
          return true;
        } catch {
          return false;
        }
      }, { timeout: 5000 }).toBe(true);
      await expect.poll(() => popup.evaluate(() => chrome.extension.isAllowedIncognitoAccess())).toBe(true);
      await popup.getByLabel("Type").selectOption("cookie");
      await popup.getByLabel("Cookie name", { exact: true }).fill("test");
      await popup.getByLabel("Value", { exact: true }).fill("managed");
      await popup.getByLabel("Site", { exact: true }).fill("127.0.0.1");
      await popup.getByLabel("Secure").uncheck();
      await popup.getByRole("button", { name: "Add cookie" }).click();
      await expect.poll(() => popup.getByText("test", { exact: true }).count()).toBe(1);
      await popup.getByLabel("Type").selectOption("query");
      await popup.getByLabel("Parameter name").fill("debug");
      await popup.getByLabel("Value", { exact: true }).fill("on");
      await popup.getByLabel("Site", { exact: true }).fill("127.0.0.1");
      await popup.getByLabel("HTTPS").uncheck();
      await popup.getByLabel("HTTP", { exact: true }).check();
      await popup.getByRole("button", { name: "Add parameter" }).click();
      await expect.poll(() => popup.getByText("debug", { exact: true }).count()).toBe(1);
      const privateWindow = await popup.evaluate((url) => chrome.windows.create({ incognito: true, url }),
        `http://127.0.0.1:${address.port}/`);
      const tabId = privateWindow?.tabs?.[0]?.id;
      if (tabId === undefined) throw new Error("No incognito tab ID");
      await expect.poll(() => popup.evaluate(async (id) => (await chrome.tabs.get(id)).url, tabId)).toContain("debug=on");
      await expect.poll(() => popup.evaluate(async () => {
        const stores = await chrome.cookies.getAllCookieStores();
        const values = await Promise.all(stores.map(async (store) =>
          (await chrome.cookies.getAll({ storeId: store.id, name: "test" })).map((cookie) => cookie.value)));
        return values.filter((items) => items.includes("managed")).length;
      })).toBe(2);
      if (privateWindow?.id === undefined) throw new Error("No incognito window ID");
      await popup.evaluate((id) => chrome.windows.remove(id), privateWindow.id);
      await expect.poll(() => popup.evaluate(async () => {
        const { cookieUndo } = await chrome.storage.session.get("cookieUndo");
        return Array.isArray(cookieUndo) ? cookieUndo.length : 0;
      })).toBe(1);
      const another = await popup.evaluate((url) => chrome.windows.create({ incognito: true, url }),
        `http://127.0.0.1:${address.port}/`);
      await expect.poll(() => popup.evaluate(async () => {
        const stores = await chrome.cookies.getAllCookieStores();
        const values = await Promise.all(stores.map(async (store) =>
          (await chrome.cookies.getAll({ storeId: store.id, name: "test" })).map((cookie) => cookie.value)));
        return values.filter((items) => items.includes("managed")).length;
      })).toBe(2);
      if (another?.id === undefined) throw new Error("No incognito window ID");
      await popup.evaluate((id) => chrome.windows.remove(id), another.id);
    } finally {
      await context.close();
    }
  } finally {
    rmSync(extensionPath, { recursive: true });
    rmSync(profilePath, { recursive: true });
    await new Promise<void>((done, reject) => server.close((error) => error ? reject(error) : done()));
  }
}, 30_000);
