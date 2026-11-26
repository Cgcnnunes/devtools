import { chromium } from "@playwright/test";
import { build } from "vite";
import { createServer } from "node:http";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { expect, it } from "vitest";

it("replaces a matching document address without reloading and rejects stale addresses", async () => {
  let requests = 0;
  const server = createServer((request, response) => {
    if (request.url !== "/favicon.ico") requests++;
    response.setHeader("content-type", "text/html");
    response.end("<script>history.replaceState({keep: 1}, '', location.href)</script>ready");
  });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Test server did not start");
  const extensionPath = mkdtempSync(join(tmpdir(), "headerlab-query-test-"));
  try {
    await build({
      configFile: false,
      logLevel: "silent",
      build: {
        outDir: extensionPath, emptyOutDir: false,
        lib: { entry: resolve("src/infrastructure/chrome-query.ts"), formats: ["es"], fileName: () => "query.js" },
      },
    });
    writeFileSync(join(extensionPath, "manifest.json"), JSON.stringify({
      manifest_version: 3, name: "HeaderLab query test", version: "1.0",
      permissions: ["scripting", "webNavigation", "storage"],
      host_permissions: ["http://127.0.0.1/*"],
      background: { service_worker: "background.js", type: "module" },
    }));
    writeFileSync(join(extensionPath, "background.js"), `
      import { chromeQuery } from "./query.js";
      chrome.runtime.onMessage.addListener((request, _sender, respond) => {
        const operation = request.action === "tab"
          ? chromeQuery.tab(request.id)
          : chromeQuery.replace(request.tab, request.url);
        operation.then((value) => respond({ value }), (error) => respond({ error: error.message }));
        return true;
      });
    `);
    writeFileSync(join(extensionPath, "popup.html"), "<!doctype html><title>Query test</title>");
    const context = await chromium.launchPersistentContext("", {
      channel: "chromium", headless: true,
      args: [`--disable-extensions-except=${extensionPath}`, `--load-extension=${extensionPath}`],
    });
    try {
      const worker = context.serviceWorkers()[0] ?? await context.waitForEvent("serviceworker");
      const extensionId = new URL(worker.url()).hostname;
      const page = await context.newPage();
      await page.goto(`http://127.0.0.1:${address.port}/?x=old`);
      const popup = await context.newPage();
      await popup.goto(`chrome-extension://${extensionId}/popup.html`);
      const id = await popup.evaluate(async (url) =>
        (await chrome.tabs.query({})).find((tab) => tab.url === url)?.id, page.url());
      if (id === undefined) throw new Error("Test tab not found");
      const initial = await popup.evaluate((tabId) => chrome.runtime.sendMessage({ action: "tab", id: tabId }), id);
      expect(initial.error).toBeUndefined();
      const before = requests;
      const next = `http://127.0.0.1:${address.port}/?x=new`;
      expect(await popup.evaluate((data) => chrome.runtime.sendMessage({
        action: "replace", tab: data.tab, url: data.url,
      }), { tab: initial.value, url: next })).toEqual({ value: true });
      expect(page.url()).toBe(next);
      expect(await page.evaluate(() => history.state)).toEqual({ keep: 1 });
      expect(requests).toBe(before);
      const current = await popup.evaluate((tabId) => chrome.runtime.sendMessage({ action: "tab", id: tabId }), id);
      expect(current.value.url).toBe(next);
      expect(await popup.evaluate((data) => chrome.runtime.sendMessage({
        action: "replace", tab: data.tab, url: data.url,
      }), { tab: initial.value, url: next })).toEqual({ value: false });
      await page.reload();
      const afterNavigation = await popup.evaluate((data) => chrome.runtime.sendMessage({
        action: "replace", tab: data.tab, url: data.url,
      }), { tab: current.value, url: `http://127.0.0.1:${address.port}/?x=stale` });
      expect(afterNavigation.error).toBeTruthy();
      expect(page.url()).toBe(next);
    } finally {
      await context.close();
    }
  } finally {
    rmSync(extensionPath, { recursive: true });
    await new Promise<void>((done, reject) => server.close((error) => error ? reject(error) : done()));
  }
}, 30_000);
