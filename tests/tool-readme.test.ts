import { readdirSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const sections = ["Setup", "How to use", "Test locally"];
const statusOrHistory =
  /\b(under development|in development|work in progress|incomplete|previously|formerly|no longer|added in|changed in|since v?\d)/i;

const tools = readdirSync("tools", { withFileTypes: true })
  .filter((entry) => entry.isDirectory())
  .map((entry) => entry.name);

describe.each(tools)("tools/%s/README.md", (tool) => {
  const readme = () => readFileSync(`tools/${tool}/README.md`, "utf8");
  const prose = () => readme().replace(/```[\s\S]*?```/g, "");

  it("has a title followed by the standard sections", () => {
    const headings = [...prose().matchAll(/^(#+) (.+)$/gm)];
    expect(headings.map((heading) => heading[1])).toEqual(["#", "##", "##", "##"]);
    expect(headings.slice(1).map((heading) => heading[2])).toEqual(sections);
  });

  it("has an intro and one diagram before the first section", () => {
    const parts = readme().split("```mermaid");
    expect(parts, "number of diagrams").toHaveLength(2);
    expect(parts[0]).not.toContain("\n## ");
    expect(parts[0].replace(/^# .+$/m, "").trim(), "intro text").not.toBe("");
  });

  it("has no folder tree", () => {
    expect(readme()).not.toMatch(/[├└│]/);
  });

  it("has no status or history notes", () => {
    expect(prose().match(statusOrHistory)?.[0], "status or history wording").toBeUndefined();
  });
});

it("lists every tool under a type in the root README contents", () => {
  const contents = readFileSync("README.md", "utf8")
    .split(/^## /m)
    .find((section) => section.startsWith("Contents")) ?? "";
  const [beforeTypes, ...types] = contents.split(/^### /m);
  expect(types.length, "type headings").toBeGreaterThan(0);
  expect(beforeTypes, "tools listed outside a type").not.toContain("tools/");
  for (const tool of tools) {
    const listed = types.filter((type) =>
      type.includes(`(tools/${tool}/README.md)`) && type.includes(`(tools/${tool}/README.md#setup)`));
    expect(listed, `${tool} listed once with README and Setup links`).toHaveLength(1);
  }
});
