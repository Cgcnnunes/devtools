import { chromium } from "@playwright/test";
import { createServer } from "node:http";
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { expect, it } from "vitest";

it.each([
  { origin: "http://api.example.test/*", visible: false },
  { origin: "https://example.test/*", visible: false },
  { origin: "http://example.test/*", visible: true },
])("checks parent-cookie visibility with $origin", async ({ origin, visible }) => {
  const server = createServer((_request, response) => {
    response.setHeader("set-cookie", "existing=original; Domain=example.test; Path=/other");
    response.end("ok");
  });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Test server did not start");
  const extensionPath = mkdtempSync(join(tmpdir(), "headerlab-cookie-test-"));
  try {
    cpSync(resolve("dist"), extensionPath, { recursive: true });
    const manifestPath = join(extensionPath, "manifest.json");
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
    manifest.permissions.push("cookies");
    manifest.host_permissions = [origin];
    writeFileSync(manifestPath, JSON.stringify(manifest));
    const context = await chromium.launchPersistentContext("", {
      channel: "chromium",
      headless: true,
      args: [
        `--disable-extensions-except=${extensionPath}`,
        `--load-extension=${extensionPath}`,
        "--host-resolver-rules=MAP *.example.test 127.0.0.1",
        "--no-proxy-server",
      ],
    });
    try {
      const page = await context.newPage();
      await page.goto(`http://api.example.test:${address.port}/`);
      expect((await context.cookies()).map((cookie) => cookie.domain)).toContain(".example.test");
      const worker = context.serviceWorkers()[0] ?? await context.waitForEvent("serviceworker");
      const cookies = await worker.evaluate(() => chrome.cookies.getAll({ name: "existing" }));
      expect(cookies.map((cookie) => cookie.domain).includes(".example.test")).toBe(visible);
    } finally {
      await context.close();
    }
  } finally {
    rmSync(extensionPath, { recursive: true });
    await new Promise<void>((done, reject) => server.close((error) => error ? reject(error) : done()));
  }
}, 30_000);
