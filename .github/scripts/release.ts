import { execFileSync } from "node:child_process";
import { appendFileSync, existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

// Top-level folder -> tag prefix. A tool is releasable when its folder is listed here.
export const categories: Readonly<Record<string, string>> = { tools: "tool" };

// Each type needs .github/workflows/deploy-<type>.yml and a deploy-<type> job in deploy.yml.
export const deployTypes = ["chrome-extension"] as const;

export type DeployType = (typeof deployTypes)[number];

export type Tool = {
  category: string;
  name: string;
  dir: string;
  type: DeployType;
  version: string;
  tag: string;
};

export type DeployTool = Pick<Tool, "name" | "dir" | "version" | "tag">;
export type Status = "deploy" | "unbumped" | "released" | "not affected";
export type Plan = { deploy: Record<DeployType, DeployTool[]>; statuses: Record<string, Status> };
export type Run = (command: string, args: string[]) => string;

function isDeployType(value: unknown): value is DeployType {
  return deployTypes.some((type) => type === value);
}

// Zero-padded MM-mm-pp keeps tags sortable. Leading zeros are rejected so two versions never share a tag.
export function releaseTag(category: string, name: string, version: string): string {
  if (!Object.hasOwn(categories, category)) {
    throw new Error(`"${category}" is not a release category (${Object.keys(categories).join(", ")})`);
  }
  const parts = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.exec(version);
  if (!parts) throw new Error(`Version "${version}" of ${name} must be MAJOR.MINOR.PATCH`);
  const [major, minor, patch] = parts.slice(1).map((part) => part.padStart(2, "0"));
  return `${categories[category]}-${name}-v${major}-${minor}-${patch}`;
}

export function readTools(root = "."): Tool[] {
  const tools: Tool[] = [];
  for (const category of Object.keys(categories)) {
    const folders = readdirSync(join(root, category), { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort();
    for (const name of folders) {
      const dir = `${category}/${name}`;
      const file = join(root, dir, "package.json");
      if (!existsSync(file)) throw new Error(`${dir}/package.json is missing`);
      const manifest: { version?: unknown; devtools?: { type?: unknown } } = JSON.parse(readFileSync(file, "utf8"));
      const type = manifest.devtools?.type;
      if (!isDeployType(type)) {
        throw new Error(`${dir}/package.json: devtools.type must be one of ${deployTypes.join(", ")}`);
      }
      if (typeof manifest.version !== "string") throw new Error(`${dir}/package.json: version is missing`);
      tools.push({ category, name, dir, type, version: manifest.version, tag: releaseTag(category, name, manifest.version) });
    }
  }
  return tools;
}

// A tool deploys when its version has no release yet, so a run that failed or never happened
// is repeated by the next one. On a pull request only the tools it changes are considered.
export function plan(input: {
  tools: Tool[];
  affected: string[];
  released: ReadonlySet<string>;
  pullRequest: boolean;
}): Plan {
  const deploy: Plan["deploy"] = { "chrome-extension": [] };
  const statuses: Plan["statuses"] = {};
  for (const tool of input.tools) {
    const changed = input.affected.includes(tool.dir);
    if (input.pullRequest && !changed) {
      statuses[tool.dir] = "not affected";
    } else if (!input.released.has(tool.tag)) {
      statuses[tool.dir] = "deploy";
      deploy[tool.type].push({ name: tool.name, dir: tool.dir, version: tool.version, tag: tool.tag });
    } else {
      statuses[tool.dir] = changed ? "unbumped" : "released";
    }
  }
  return { deploy, statuses };
}

// Turborepo reads the commit range from TURBO_SCM_BASE and TURBO_SCM_HEAD.
export function affectedDirs(base: string | undefined, run: Run): string[] {
  if (!base || /^0+$/.test(base)) return [];
  const output: { packages: { items: { path: string }[] } } = JSON.parse(
    run("npx", ["turbo", "ls", "--affected", "--output=json"]),
  );
  return output.packages.items.map((item) => item.path);
}

export function releaseExists(tag: string, run: Run): boolean {
  try {
    run("gh", ["release", "view", tag, "--json", "tagName"]);
    return true;
  } catch (error) {
    if (String((error as { stderr?: unknown }).stderr).includes("release not found")) return false;
    throw error;
  }
}

const exec: Run = (command, args) =>
  execFileSync(command, args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });

const labels: Record<Status, string> = {
  deploy: "deploy",
  unbumped: "changed, but this version is already released: nothing is deployed",
  released: "already released",
  "not affected": "not changed by this pull request",
};

function report(result: Plan, tools: Tool[], pullRequest: boolean, env: NodeJS.ProcessEnv): void {
  for (const tool of tools) {
    if (result.statuses[tool.dir] !== "unbumped") continue;
    console.log(
      `::warning title=Version not bumped::${tool.dir} changed but ${tool.tag} is already released, so nothing is deployed. Raise "version" in ${tool.dir}/package.json to release the change.`,
    );
  }
  const summary = [
    `### Deploy plan${pullRequest ? " (dry run: nothing is published)" : ""}`,
    "",
    "| Tool | Version | Tag | Result |",
    "| --- | --- | --- | --- |",
    ...tools.map((tool) => `| ${tool.dir} | ${tool.version} | \`${tool.tag}\` | ${labels[result.statuses[tool.dir]]} |`),
    "",
  ].join("\n");
  const output = `deploy=${JSON.stringify(result.deploy)}`;
  if (env.GITHUB_OUTPUT) appendFileSync(env.GITHUB_OUTPUT, `${output}\n`);
  else console.log(output);
  if (env.GITHUB_STEP_SUMMARY) appendFileSync(env.GITHUB_STEP_SUMMARY, `${summary}\n`);
  else console.log(summary);
}

function main(args: string[], env: NodeJS.ProcessEnv): void {
  if (args[0] !== "plan") throw new Error("Usage: node .github/scripts/release.ts plan");
  const tools = readTools();
  const pullRequest = env.GITHUB_EVENT_NAME === "pull_request";
  let affected: string[] = [];
  try {
    affected = affectedDirs(env.TURBO_SCM_BASE, exec);
  } catch (error) {
    if (pullRequest) throw error;
    console.log(`::warning::Could not find the tools this change touches (${error}), so unreleased versions are still deployed but unbumped changes are not reported.`);
  }
  const candidates = pullRequest ? tools.filter((tool) => affected.includes(tool.dir)) : tools;
  const released = new Set(candidates.filter((tool) => releaseExists(tool.tag, exec)).map((tool) => tool.tag));
  report(plan({ tools, affected, released, pullRequest }), tools, pullRequest, env);
}

if (import.meta.main) {
  try {
    main(process.argv.slice(2), process.env);
  } catch (error) {
    console.error(`${process.env.GITHUB_ACTIONS ? "::error::" : ""}${error instanceof Error ? error.message : error}`);
    process.exitCode = 1;
  }
}
