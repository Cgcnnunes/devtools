import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  affectedDirs,
  deployTypes,
  gateProblems,
  plan,
  readTools,
  releaseExists,
  releaseTag,
  touchesPipeline,
  type Tool,
} from "../.github/scripts/release.js";

function tool(name: string, version = "1.0.0"): Tool {
  return {
    category: "tools",
    name,
    dir: `tools/${name}`,
    type: "chrome-extension",
    version,
    tag: releaseTag("tools", name, version),
  };
}

function failure(stderr: string): Error {
  return Object.assign(new Error("Command failed"), { stderr });
}

describe("releaseTag", () => {
  it("builds <category>-<name>-vMM-mm-pp from the folder and the version", () => {
    expect(releaseTag("tools", "headerlab", "0.5.0")).toBe("tool-headerlab-v00-05-00");
    expect(releaseTag("tools", "headerlab", "12.3.40")).toBe("tool-headerlab-v12-03-40");
  });

  it.each(["", "0.5", "v0.5.0", "0.5.0-beta.1", "1.2.3.4", "01.0.0", "1.02.3"])("rejects the version %j", (version) => {
    expect(() => releaseTag("tools", "headerlab", version)).toThrow(/MAJOR\.MINOR\.PATCH/);
  });

  it("rejects a folder that is not a release category", () => {
    expect(() => releaseTag("packages", "shared", "1.0.0")).toThrow(/category/);
  });
});

describe("readTools", () => {
  const roots: string[] = [];
  afterEach(() => {
    for (const root of roots.splice(0)) rmSync(root, { recursive: true });
  });

  function repository(packageJson: object): string {
    const root = mkdtempSync(join(tmpdir(), "devtools-release-"));
    roots.push(root);
    mkdirSync(join(root, "tools", "demo"), { recursive: true });
    writeFileSync(join(root, "tools", "demo", "package.json"), JSON.stringify(packageJson));
    return root;
  }

  it("reads the name, deploy type, version and tag of each tool", () => {
    const root = repository({ name: "demo", version: "1.2.3", devtools: { type: "chrome-extension" } });
    expect(readTools(root)).toEqual([
      { category: "tools", name: "demo", dir: "tools/demo", type: "chrome-extension", version: "1.2.3", tag: "tool-demo-v01-02-03" },
    ]);
  });

  it.each([
    ["no devtools.type", { version: "1.0.0" }],
    ["an unknown devtools.type", { version: "1.0.0", devtools: { type: "unknown" } }],
  ])("rejects a tool with %s", (_label, packageJson) => {
    expect(() => readTools(repository(packageJson))).toThrow(/tools\/demo.*devtools\.type/);
  });
});

describe("plan", () => {
  const a = tool("a");
  const b = tool("b");

  it("deploys each tool whose version has no release and flags a changed tool that is already released", () => {
    const result = plan({ tools: [a, b], affected: [b.dir], released: new Set([b.tag]), pullRequest: false });
    expect(result.deploy).toEqual({
      "chrome-extension": [{ name: "a", dir: "tools/a", version: "1.0.0", tag: a.tag }],
    });
    expect(result.statuses).toEqual({ [a.dir]: "deploy", [b.dir]: "unbumped" });
  });

  it("deploys an unchanged tool whose version was never released, so a missed run heals on the next merge", () => {
    const result = plan({ tools: [a], affected: [], released: new Set(), pullRequest: false });
    expect(result.statuses).toEqual({ [a.dir]: "deploy" });
  });

  it("leaves an unchanged released tool alone", () => {
    const result = plan({ tools: [a], affected: [], released: new Set([a.tag]), pullRequest: false });
    expect(result.deploy).toEqual({ "chrome-extension": [] });
    expect(result.statuses).toEqual({ [a.dir]: "released" });
  });

  it("only considers the tools a pull request changes", () => {
    const result = plan({ tools: [a, b], affected: [a.dir], released: new Set(), pullRequest: true });
    expect(result.deploy["chrome-extension"].map((entry) => entry.name)).toEqual(["a"]);
    expect(result.statuses).toEqual({ [a.dir]: "deploy", [b.dir]: "not affected" });
  });

  it("builds a changed tool on a pull request even when its version is already released, because nothing is published", () => {
    const result = plan({ tools: [a], affected: [a.dir], released: new Set([a.tag]), pullRequest: true });
    expect(result.deploy["chrome-extension"].map((entry) => entry.name)).toEqual(["a"]);
    expect(result.statuses).toEqual({ [a.dir]: "unbumped" });
  });

  it("builds every tool on a pull request that changes the pipeline, so the pipeline is rehearsed", () => {
    const result = plan({ tools: [a, b], affected: [], released: new Set([b.tag]), pullRequest: true, pipelineChanged: true });
    expect(result.deploy["chrome-extension"].map((entry) => entry.name)).toEqual(["a", "b"]);
    expect(result.statuses).toEqual({ [a.dir]: "deploy", [b.dir]: "released" });
  });

  it("ignores a pipeline change on a merge, which already considers every tool", () => {
    const result = plan({ tools: [a, b], affected: [], released: new Set([b.tag]), pullRequest: false, pipelineChanged: true });
    expect(result.deploy["chrome-extension"].map((entry) => entry.name)).toEqual(["a"]);
  });

  it("lists every deploy type, even one with nothing to deploy", () => {
    const result = plan({ tools: [], affected: [], released: new Set(), pullRequest: false });
    expect(Object.keys(result.deploy)).toEqual([...deployTypes]);
  });
});

describe("touchesPipeline", () => {
  it("asks git whether the deploy workflows or the release scripts changed", () => {
    const calls: string[][] = [];
    const changed = touchesPipeline("abc123", "def456", (command, args) => {
      calls.push([command, ...args]);
      return ".github/scripts/release.ts\n";
    });
    expect(changed).toBe(true);
    expect(calls).toEqual([
      ["git", "diff", "--name-only", "abc123", "def456", "--", ".github/workflows/deploy*.yml", ".github/scripts"],
    ]);
  });

  it("is false when none of them changed", () => {
    expect(touchesPipeline("abc123", "def456", () => "\n")).toBe(false);
  });

  it.each([undefined, "", "0000000000000000000000000000000000000000"])(
    "is false without a usable base commit (%j)",
    (base) => {
      expect(touchesPipeline(base, "def456", () => { throw new Error("must not run"); })).toBe(false);
    },
  );
});

describe("gateProblems", () => {
  const planned = { "chrome-extension": [{ name: "a", dir: "tools/a", version: "1.0.0", tag: "tool-a-v01-00-00" }] };
  const nothing = { "chrome-extension": [] };
  const success = { result: "success" };

  it("passes when every job succeeded and every planned deploy ran", () => {
    const needs = { quality: success, plan: success, "deploy-chrome-extension": success };
    expect(gateProblems(planned, needs)).toEqual([]);
  });

  it("passes when nothing was planned, even though the deploy job and a pull request's quality job were skipped", () => {
    const needs = { quality: { result: "skipped" }, plan: success, "deploy-chrome-extension": { result: "skipped" } };
    expect(gateProblems(nothing, needs)).toEqual([]);
  });

  it.each(["failure", "cancelled"])("fails when a job ends %s", (result) => {
    const problems = gateProblems(nothing, { quality: { result }, plan: success });
    expect(problems).toEqual([expect.stringContaining("quality")]);
  });

  it("fails when a planned deploy was skipped, so a skipped job never looks like a success", () => {
    const needs = { quality: success, plan: success, "deploy-chrome-extension": { result: "skipped" } };
    expect(gateProblems(planned, needs)).toEqual([expect.stringContaining("deploy-chrome-extension")]);
  });

  it("reports a failed deploy once", () => {
    const needs = { quality: success, plan: success, "deploy-chrome-extension": { result: "failure" } };
    expect(gateProblems(planned, needs)).toEqual(["deploy-chrome-extension failure"]);
  });

  it("fails when the job for a planned deploy type is missing from the gate", () => {
    expect(gateProblems(planned, { quality: success, plan: success })).toEqual([expect.stringContaining("deploy-chrome-extension")]);
  });
});

describe("affectedDirs", () => {
  const output = JSON.stringify({
    packageManager: "npm",
    packages: { count: 1, items: [{ name: "headerlab", path: "tools/headerlab" }] },
  });

  it("asks Turborepo which tools changed since the base commit", () => {
    const calls: string[][] = [];
    const dirs = affectedDirs("abc123", (command, args) => {
      calls.push([command, ...args]);
      return output;
    });
    expect(dirs).toEqual(["tools/headerlab"]);
    expect(calls).toEqual([["npx", "turbo", "ls", "--affected", "--output=json"]]);
  });

  it.each([undefined, "", "0000000000000000000000000000000000000000"])(
    "reports nothing without a usable base commit (%j)",
    (base) => {
      expect(affectedDirs(base, () => { throw new Error("must not run"); })).toEqual([]);
    },
  );
});

describe("releaseExists", () => {
  it("is true when gh finds the release", () => {
    expect(releaseExists("tool-demo-v01-00-00", () => "{}")).toBe(true);
  });

  it("is false when gh reports that the release was not found", () => {
    expect(releaseExists("tool-demo-v01-00-00", () => { throw failure("release not found\n"); })).toBe(false);
  });

  it("fails on any other gh error instead of guessing", () => {
    expect(() => releaseExists("tool-demo-v01-00-00", () => { throw failure("HTTP 401: Bad credentials"); }))
      .toThrow("Command failed");
  });
});

describe("this repository", () => {
  it("gives every tool one release tag in the documented format", () => {
    const tools = readTools(".");
    expect(tools.length, "tools").toBeGreaterThan(0);
    for (const entry of tools) expect(entry.tag).toMatch(/^tool-[a-z0-9-]+-v\d{2}-\d{2}-\d{2}$/);
    expect(new Set(tools.map((entry) => entry.tag)).size).toBe(tools.length);
  });
});

function jobBlock(workflow: string, id: string): string {
  const lines = workflow.split("\n");
  const start = lines.indexOf(`  ${id}:`);
  if (start < 0) return "";
  const end = lines.findIndex((line, index) => index > start && /^ {2}\S/.test(line));
  return lines.slice(start, end < 0 ? undefined : end).join("\n");
}

describe("deploy workflows", () => {
  const deploy = () => readFileSync(".github/workflows/deploy.yml", "utf8");

  it("calls one reusable workflow per deploy type and no other", () => {
    const called = [...deploy().matchAll(/uses: \.\/\.github\/workflows\/deploy-([a-z-]+)\.yml/g)].map((match) => match[1]);
    expect(called.sort()).toEqual([...deployTypes].sort());
  });

  it("ends in a gate that runs the tested gate script", () => {
    expect(jobBlock(deploy(), "deployed")).toContain("node .github/scripts/release.ts gate");
  });

  it.each(deployTypes)("%s is reusable and creates the release itself", (type) => {
    const workflow = readFileSync(`.github/workflows/deploy-${type}.yml`, "utf8");
    expect(workflow, "workflow_call trigger").toMatch(/^on:\n {2}workflow_call:/m);
    expect(workflow, "release creation").toContain("gh release create");
  });

  // GitHub skips a job whose ancestor was skipped unless its own if has a status function.
  // Pull requests skip quality, so without one the dry run is silently skipped.
  it.each(deployTypes)("%s runs on a pull request, where quality is skipped, and the gate awaits it", (type) => {
    const job = jobBlock(deploy(), `deploy-${type}`);
    expect(job, "job").not.toBe("");
    expect(job, "status function in if").toMatch(/^ {4}if: .*(!cancelled\(\)|always\(\)|!failure\(\))/m);
    expect(jobBlock(deploy(), "deployed"), "needs of the deployed job").toMatch(new RegExp(`needs: \\[[^\\]]*deploy-${type}`));
  });

  it("builds a chrome extension through Turborepo, so its workspace dependencies are built first", () => {
    const workflow = readFileSync(".github/workflows/deploy-chrome-extension.yml", "utf8");
    expect(workflow).toContain("turbo run build");
  });
});
