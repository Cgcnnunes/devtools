import { chromium } from "@playwright/test";
import { createServer } from "node:http";
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { expect, it } from "vitest";

it("confirms cookie replacements and restores them on deactivation", async () => {
  const server = createServer((_request, response) => {
    response.setHeader("set-cookie", ["test=old; Path=/", "test=other; Path=/account; HttpOnly"]);
    response.end("ready");
  });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Test server did not start");
  const extensionPath = mkdtempSync(join(tmpdir(), "headerlab-cookie-popup-test-"));
  try {
    cpSync(resolve("dist"), extensionPath, { recursive: true });
    const manifestPath = join(extensionPath, "manifest.json");
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
    manifest.host_permissions = ["http://127.0.0.1/*", "https://127.0.0.1/*"];
    writeFileSync(manifestPath, JSON.stringify(manifest));
    const context = await chromium.launchPersistentContext("", {
      channel: "chromium", headless: true,
      args: [`--disable-extensions-except=${extensionPath}`, `--load-extension=${extensionPath}`],
    });
    try {
      const worker = context.serviceWorkers()[0] ?? await context.waitForEvent("serviceworker");
      const page = await context.newPage();
      await page.goto(`http://127.0.0.1:${address.port}/`);
      const popup = await context.newPage();
      await popup.goto(`chrome-extension://${new URL(worker.url()).hostname}/index.html`);
      await expect.poll(() => popup.getByRole("checkbox", { name: "Activate" }).isEnabled()).toBe(true);
      await popup.getByLabel("Type").selectOption("cookie");
      await popup.getByLabel("Cookie name", { exact: true }).fill("test");
      await popup.getByLabel("Value", { exact: true }).fill("managed");
      await popup.getByLabel("Site", { exact: true }).fill("127.0.0.1");
      await popup.getByLabel("Secure").uncheck();
      await popup.getByRole("button", { name: "Add cookie" }).click();
      await expect.poll(() => popup.getByText("Cookie conflict", { exact: true }).count()).toBe(1);
      expect(await popup.locator("#conflicts-list").textContent()).toContain("127.0.0.1/account");
      expect((await context.cookies()).filter((cookie) => cookie.name === "test").map((cookie) => cookie.value).sort())
        .toEqual(["old", "other"]);
      const cdp = await context.newCDPSession(popup);
      const { targetInfos } = await cdp.send("Target.getTargets");
      const target = targetInfos.find((info) => info.type === "service_worker" && info.url === worker.url());
      if (!target) throw new Error("HeaderLab service worker was not found");
      expect((await cdp.send("Target.closeTarget", { targetId: target.targetId })).success).toBe(true);
      await popup.reload();
      await expect.poll(() => popup.getByText("Cookie conflict", { exact: true }).count()).toBe(1);
      const revision = await popup.evaluate(async () => {
        const { cookieConflicts } = await chrome.storage.session.get("cookieConflicts");
        if (!Array.isArray(cookieConflicts) || typeof cookieConflicts[0]?.revision !== "string") {
          throw new Error("Missing conflict revision");
        }
        return cookieConflicts[0].revision;
      });
      await popup.getByRole("button", { name: "Edit" }).click();
      await popup.getByLabel("Value", { exact: true }).fill("next");
      await popup.getByRole("button", { name: "Save cookie" }).click();
      await expect.poll(() => popup.getByRole("button", { name: "Add cookie" }).isEnabled()).toBe(true);
      const stale = await popup.evaluate((oldRevision) => chrome.runtime.sendMessage({
        type: "resolve-cookie", id: 1, revision: oldRevision, decision: "replace",
      }), revision);
      expect(stale.ok).toBe(false);
      await popup.getByRole("button", { name: "Keep cookies and disable rule" }).click();
      const toggle = popup.getByRole("checkbox", { name: "Enable cookie test for 127.0.0.1" });
      await expect.poll(() => toggle.isChecked()).toBe(false);
      expect((await context.cookies()).filter((cookie) => cookie.name === "test").map((cookie) => cookie.value).sort())
        .toEqual(["old", "other"]);
      await toggle.check();
      await expect.poll(() => popup.getByText("Cookie conflict", { exact: true }).count()).toBe(1);
      await popup.getByRole("button", { name: "Replace cookies" }).click();
      await expect.poll(async () => (await context.cookies()).filter((cookie) => cookie.name === "test")
        .map((cookie) => cookie.value)).toEqual(["next"]);
      const restartedTargets = await cdp.send("Target.getTargets");
      const restartedWorker = restartedTargets.targetInfos.find((info) =>
        info.type === "service_worker" && info.url === worker.url());
      if (!restartedWorker) throw new Error("Restarted HeaderLab service worker was not found");
      expect((await cdp.send("Target.closeTarget", { targetId: restartedWorker.targetId })).success).toBe(true);
      await popup.reload();
      await expect.poll(() => popup.getByRole("checkbox", { name: "Activate" }).isEnabled()).toBe(true);
      const cookieGroup = popup.getByRole("checkbox", { name: "Enable all cookies" });
      await cookieGroup.uncheck();
      await expect.poll(async () => (await context.cookies()).filter((cookie) => cookie.name === "test")
        .map((cookie) => cookie.value).sort()).toEqual(["old", "other"]);
      await cookieGroup.check();
      await expect.poll(() => popup.getByText("Cookie conflict", { exact: true }).count()).toBe(1);
      await popup.getByRole("button", { name: "Replace cookies" }).click();
      await expect.poll(async () => (await context.cookies()).filter((cookie) => cookie.name === "test")
        .map((cookie) => cookie.value)).toEqual(["next"]);
      await popup.getByRole("checkbox", { name: "Activate" }).uncheck();
      await expect.poll(async () => (await context.cookies()).filter((cookie) => cookie.name === "test")
        .map((cookie) => cookie.value).sort()).toEqual(["old", "other"]);
      await popup.getByRole("checkbox", { name: "Activate" }).check();
      await expect.poll(() => popup.getByText("Cookie conflict", { exact: true }).count()).toBe(1);
      await popup.getByRole("button", { name: "Replace cookies" }).click();
      await expect.poll(async () => (await context.cookies()).filter((cookie) => cookie.name === "test")
        .map((cookie) => cookie.value)).toEqual(["next"]);
      await context.addCookies([{
        name: "test", value: "site-changed", domain: "127.0.0.1", path: "/",
      }]);
      await popup.getByRole("checkbox", { name: "Activate" }).uncheck();
      await expect.poll(() => popup.locator("#warnings-list").textContent()).toContain("preserved");
      expect((await context.cookies()).filter((cookie) => cookie.name === "test").map((cookie) => cookie.value))
        .toEqual(["site-changed"]);
      await popup.getByRole("button", { name: "Delete" }).click();
      await expect.poll(() => popup.getByText("No rules yet.").isVisible()).toBe(true);
      await popup.getByLabel("Type").selectOption("cookie");
      await popup.getByLabel("Cookie name", { exact: true }).fill("another");
      await popup.getByLabel("Site", { exact: true }).fill("127.0.0.1");
      await popup.getByRole("button", { name: "Add cookie" }).click();
      await expect.poll(async () => popup.evaluate(async () => {
        const { cookieRules } = await chrome.storage.local.get("cookieRules");
        return Array.isArray(cookieRules) ? cookieRules[0]?.id : undefined;
      })).toBe(2);
    } finally {
      await context.close();
    }
  } finally {
    rmSync(extensionPath, { recursive: true });
    await new Promise<void>((done, reject) => server.close((error) => error ? reject(error) : done()));
  }
}, 30_000);
