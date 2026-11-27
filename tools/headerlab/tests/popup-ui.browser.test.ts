import { chromium, type BrowserContextOptions, type Page } from "@playwright/test";
import { createServer } from "vite";
import { expect, it } from "vitest";

async function withPopup(run: (page: Page) => Promise<void>, options: BrowserContextOptions = {}): Promise<void> {
  const server = await createServer({ server: { host: "127.0.0.1", port: 0 }, logLevel: "silent" });
  try {
    await server.listen();
    const address = server.httpServer?.address();
    if (!address || typeof address === "string") throw new Error("Preview server did not start");
    const browser = await chromium.launch({ channel: "chromium", headless: true });
    try {
      const page = await (await browser.newContext(options)).newPage();
      await page.goto(`http://127.0.0.1:${address.port}/`);
      await expect.poll(() => page.getByRole("checkbox", { name: "Activate" }).isEnabled()).toBe(true);
      await run(page);
    } finally {
      await browser.close();
    }
  } finally {
    await server.close();
  }
}

it("shows no explanatory text above the cookie and query forms", async () => {
  await withPopup(async (page) => {
    const editor = page.getByRole("region", { name: "Rule editor" });
    await page.getByLabel("Type").selectOption("cookie");
    expect(await editor.innerText()).not.toContain("Session cookies only");
    await page.getByLabel("Type").selectOption("query");
    expect(await editor.innerText()).not.toContain("Matching addresses change");
  });
}, 30_000);

it("animates the Detect button while it is pressed", async () => {
  await withPopup(async (page) => {
    const detect = page.getByRole("button", { name: "Detect" });
    const scale = () => detect.evaluate((button) => new DOMMatrix(getComputedStyle(button).transform).a);
    const cdp = await page.context().newCDPSession(page);
    await cdp.send("Animation.enable");
    const animated: string[] = [];
    cdp.on("Animation.animationStarted", ({ animation }) => animated.push(animation.name));

    expect(await scale()).toBe(1);
    await detect.hover();
    await page.mouse.down();
    await expect.poll(scale).toBeLessThan(1);
    expect(animated).toContain("transform");
    await page.mouse.up();
    await expect.poll(scale).toBe(1);
  });
}, 30_000);

it("presses the Detect button without moving it when reduced motion is requested", async () => {
  await withPopup(async (page) => {
    const detect = page.getByRole("button", { name: "Detect" });
    const style = () => detect.evaluate((button) => {
      const { backgroundColor, transform } = getComputedStyle(button);
      return { backgroundColor, transform };
    });
    const rest = await style();
    await detect.hover();
    await page.mouse.down();
    await expect.poll(async () => (await style()).backgroundColor).not.toBe(rest.backgroundColor);
    expect((await style()).transform).toBe("none");
    await page.mouse.up();
  }, { reducedMotion: "reduce" });
}, 30_000);
