import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";

const chapters = ["What it does", "Triggered", "Diagram", "Jobs", "Permissions", "If it fails"];

const workflows = readdirSync(".github/workflows")
  .filter((file) => file.endsWith(".yml"))
  .map((file) => file.replace(/\.yml$/, ""));

const pages = ["docs/workflows/README.md", ...workflows.map((name) => `docs/workflows/${name}/README.md`)];

const prose = (markdown: string) => markdown.replace(/```[\s\S]*?```/g, "");
const diagrams = (markdown: string) => markdown.match(/```mermaid/g)?.length ?? 0;

function chapter(markdown: string, title: string): string {
  return markdown.split(/^## /m).slice(1).find((part) => part.startsWith(`${title}\n`)) ?? "";
}

// Top-level keys indented under a root key, for example the events under `on:` or the jobs under `jobs:`.
function keysUnder(workflow: string, root: string): string[] {
  const lines = workflow.split("\n");
  const keys: string[] = [];
  for (const line of lines.slice(lines.indexOf(`${root}:`) + 1)) {
    if (line !== "" && !line.startsWith(" ")) break;
    const key = /^ {2}([\w-]+):/.exec(line)?.[1];
    if (key) keys.push(key);
  }
  return keys;
}

describe("docs/workflows/README.md", () => {
  const index = () => readFileSync("docs/workflows/README.md", "utf8");

  it("links every workflow to its page", () => {
    for (const name of workflows) expect(index(), name).toContain(`](${name}/README.md)`);
  });

  it("has a page folder for no workflow that is gone", () => {
    const folders = readdirSync("docs/workflows", { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name);
    expect(folders.sort()).toEqual([...workflows].sort());
  });

  it("shows how the workflows fit together in one diagram", () => {
    expect(diagrams(index())).toBe(1);
  });
});

describe.each(workflows)("docs/workflows/%s/README.md", (name) => {
  const page = () => readFileSync(`docs/workflows/${name}/README.md`, "utf8");
  const workflow = () => readFileSync(`.github/workflows/${name}.yml`, "utf8");

  it("has a title followed by the standard chapters", () => {
    const headings = [...prose(page()).matchAll(/^(#{1,2}) (.+)$/gm)];
    expect(headings.map((heading) => heading[1])).toEqual(["#", ...chapters.map(() => "##")]);
    expect(headings.slice(1).map((heading) => heading[2])).toEqual(chapters);
  });

  it("has one diagram, in the Diagram chapter", () => {
    expect(diagrams(page()), "diagrams").toBe(1);
    expect(diagrams(chapter(page(), "Diagram")), "diagrams in the Diagram chapter").toBe(1);
  });

  it("names every event that triggers the workflow", () => {
    const triggered = chapter(page(), "Triggered");
    for (const event of keysUnder(workflow(), "on")) expect(triggered, event).toContain(`\`${event}\``);
  });

  it("names every job of the workflow", () => {
    const jobs = chapter(page(), "Jobs");
    for (const job of keysUnder(workflow(), "jobs")) expect(jobs, job).toContain(`\`${job}\``);
  });

  it("links to the workflow file", () => {
    expect(page()).toContain(`](../../../.github/workflows/${name}.yml)`);
  });
});

describe.each(pages)("%s", (file) => {
  it("only links to files that exist", () => {
    const links = [...readFileSync(file, "utf8").matchAll(/\]\(([^)\s]+)\)/g)]
      .map((match) => match[1])
      .filter((link) => !/^(https?:|mailto:|#)/.test(link));
    for (const link of links) expect(existsSync(join(dirname(file), link.split("#")[0])), link).toBe(true);
  });
});
