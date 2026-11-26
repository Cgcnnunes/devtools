import { chromium } from "@playwright/test";
import { build } from "vite";
import { createServer } from "node:http";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { expect, it } from "vitest";

it.each([
  { host: "127.0.0.1", parent: undefined, secure: false },
  { host: "api.example.test", parent: "example.test", secure: true },
])("replaces and restores same-name cookies across paths on $host", async ({ host, parent, secure }) => {
  const server = createServer((_request, response) => {
    response.setHeader("set-cookie", [
      `test=old; Path=/${parent ? `; Domain=${parent}` : ""}`,
      "test=other; Path=/account; HttpOnly",
    ]);
    response.end("ready");
  });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Test server did not start");
  const extensionPath = mkdtempSync(join(tmpdir(), "headerlab-cookie-adapter-test-"));
  try {
    await build({
      configFile: false,
      logLevel: "silent",
      build: {
        outDir: extensionPath, emptyOutDir: false,
        lib: {
          entry: {
            engine: resolve("src/application/cookie-engine.ts"),
            cookies: resolve("src/infrastructure/chrome-cookies.ts"),
          },
          formats: ["es"],
          fileName: (_format, name) => `${name}.js`,
        },
      },
    });
    writeFileSync(join(extensionPath, "manifest.json"), JSON.stringify({
      manifest_version: 3, name: "HeaderLab cookie test", version: "1.0",
      permissions: ["cookies", "storage"],
      host_permissions: [host, ...(parent ? [parent] : [])].flatMap((name) =>
        [`http://${name}/*`, `https://${name}/*`]),
      background: { service_worker: "background.js", type: "module" },
    }));
    writeFileSync(join(extensionPath, "background.js"), `
      import { CookieEngine } from "./engine.js";
      import { chromeCookies } from "./cookies.js";
      const engine = new CookieEngine(chromeCookies);
      chrome.runtime.onMessage.addListener((request, _sender, respond) => {
        const operation = request.action === "apply"
          ? engine.apply(request.rule, request.approved)
          : engine.undo(request.id);
        operation.then((value) => respond({ value }), (error) => respond({ error: error.message }));
        return true;
      });
    `);
    writeFileSync(join(extensionPath, "popup.html"), "<!doctype html><title>Cookie test</title>");
    const context = await chromium.launchPersistentContext("", {
      channel: "chromium", headless: true,
      args: [
        `--disable-extensions-except=${extensionPath}`, `--load-extension=${extensionPath}`,
        "--host-resolver-rules=MAP *.example.test 127.0.0.1", "--no-proxy-server",
      ],
    });
    try {
      const worker = context.serviceWorkers()[0] ?? await context.waitForEvent("serviceworker");
      const extensionId = new URL(worker.url()).hostname;
      const page = await context.newPage();
      await page.goto(`http://${host}:${address.port}/`);
      const popup = await context.newPage();
      await popup.goto(`chrome-extension://${extensionId}/popup.html`);
      const rule = {
        id: 1, enabled: true, site: host, includeSubdomains: false,
        name: "test", value: "managed", path: "/", secure, httpOnly: true, sameSite: "lax",
      };
      const plan = await popup.evaluate((input) => chrome.runtime.sendMessage({ action: "apply", rule: input }), rule);
      expect(plan.error).toBeUndefined();
      expect(plan.value.conflicts).toHaveLength(2);
      const applied = await popup.evaluate((input) => chrome.runtime.sendMessage({
        action: "apply", rule: input.rule, approved: input.conflicts,
      }), { rule, conflicts: plan.value.conflicts });
      expect(applied).toEqual({ value: { conflicts: [] } });
      const managed = (await context.cookies()).filter((cookie) => cookie.name === "test");
      expect(managed.map((cookie) => [cookie.value, cookie.path, cookie.httpOnly])).toEqual([["managed", "/", true]]);
      expect(await popup.evaluate(() => chrome.runtime.sendMessage({ action: "undo", id: 1 }))).toEqual({ value: [] });
      const restored = (await context.cookies()).filter((cookie) => cookie.name === "test");
      expect(restored.map((cookie) => [cookie.value, cookie.path, cookie.httpOnly]).sort()).toEqual([
        ["old", "/", false], ["other", "/account", true],
      ]);
    } finally {
      await context.close();
    }
  } finally {
    rmSync(extensionPath, { recursive: true });
    await new Promise<void>((done, reject) => server.close((error) => error ? reject(error) : done()));
  }
}, 30_000);
