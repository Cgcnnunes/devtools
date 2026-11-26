import { chromium } from "@playwright/test";
import { createServer } from "node:http";
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { expect, it } from "vitest";

it("manages query rules and conflicts through the extension popup", async () => {
  let requests = 0;
  const server = createServer((request, response) => {
    if (request.url !== "/favicon.ico") requests++;
    response.setHeader("content-type", "text/html");
    response.end("ready");
  });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Test server did not start");
  const extensionPath = mkdtempSync(join(tmpdir(), "headerlab-query-popup-test-"));
  try {
    cpSync(resolve("dist"), extensionPath, { recursive: true });
    const manifestPath = join(extensionPath, "manifest.json");
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
    manifest.host_permissions = ["http://127.0.0.1/*"];
    writeFileSync(manifestPath, JSON.stringify(manifest));
    const context = await chromium.launchPersistentContext("", {
      channel: "chromium", headless: true,
      args: [`--disable-extensions-except=${extensionPath}`, `--load-extension=${extensionPath}`],
    });
    try {
      const worker = context.serviceWorkers()[0] ?? await context.waitForEvent("serviceworker");
      const extensionId = new URL(worker.url()).hostname;
      const page = await context.newPage();
      await page.goto(`http://127.0.0.1:${address.port}/?debug=old`);
      const popup = await context.newPage();
      await popup.goto(`chrome-extension://${extensionId}/index.html`);
      await expect.poll(() => popup.getByRole("checkbox", { name: "Activate" }).isEnabled()).toBe(true);
      await popup.getByLabel("Type").selectOption("query");
      await popup.getByLabel("Parameter name").fill("debug");
      await popup.getByLabel("Value", { exact: true }).fill("on");
      await popup.getByLabel("Site", { exact: true }).fill("127.0.0.1");
      await popup.getByLabel("HTTPS").uncheck();
      await popup.getByLabel("HTTP", { exact: true }).check();
      await popup.getByRole("button", { name: "Add parameter" }).click();
      await expect.poll(() => popup.getByText("Query conflict", { exact: true }).count()).toBe(1);
      expect(page.url()).toContain("debug=old");
      const newPage = await context.newPage();
      await newPage.goto(`http://127.0.0.1:${address.port}/fresh`);
      await expect.poll(() => newPage.url()).toContain("debug=on");
      const before = requests;
      await popup.getByRole("button", { name: "Replace value" }).click();
      await expect.poll(() => page.url()).toContain("debug=on");
      expect(requests).toBe(before);
      const cdp = await context.newCDPSession(popup);
      const { targetInfos } = await cdp.send("Target.getTargets");
      const target = targetInfos.find((info) => info.type === "service_worker" && info.url === worker.url());
      if (!target) throw new Error("HeaderLab service worker was not found");
      expect((await cdp.send("Target.closeTarget", { targetId: target.targetId })).success).toBe(true);
      await popup.reload();
      await expect.poll(() => popup.getByRole("checkbox", { name: "Activate" }).isEnabled()).toBe(true);
      const queryGroup = popup.getByRole("checkbox", { name: "Enable all query parameters" });
      await queryGroup.uncheck();
      await expect.poll(() => page.url()).toContain("debug=old");
      await queryGroup.check();
      await expect.poll(() => popup.getByText("Query conflict", { exact: true }).count()).toBe(1);
      await popup.getByRole("button", { name: "Replace value" }).click();
      await expect.poll(() => page.url()).toContain("debug=on");
      await popup.getByRole("checkbox", { name: "Activate" }).uncheck();
      await expect.poll(() => page.url()).toContain("debug=old");
      await expect.poll(() => newPage.url()).toBe(`http://127.0.0.1:${address.port}/fresh`);
      expect(requests).toBe(before);
    } finally {
      await context.close();
    }
  } finally {
    rmSync(extensionPath, { recursive: true });
    await new Promise<void>((done, reject) => server.close((error) => error ? reject(error) : done()));
  }
}, 30_000);
