import { execFileSync } from "node:child_process";
import { appendFileSync, existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

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
export type Needs = Record<string, { result: string }>;
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
// is repeated by the next one. A pull request publishes nothing, so it builds every tool it
// changes (every tool when it changes the pipeline) whatever their release state.
export function plan(input: {
  tools: Tool[];
  affected: string[];
  released: ReadonlySet<string>;
  pullRequest: boolean;
  pipelineChanged?: boolean;
}): Plan {
  const deploy: Plan["deploy"] = { "chrome-extension": [] };
  const statuses: Plan["statuses"] = {};
  for (const tool of input.tools) {
    const changed = input.affected.includes(tool.dir);
    if (input.pullRequest && !changed && !input.pipelineChanged) {
      statuses[tool.dir] = "not affected";
      continue;
    }
    const released = input.released.has(tool.tag);
    statuses[tool.dir] = !released ? "deploy" : changed ? "unbumped" : "released";
    if (!released || input.pullRequest) {
      deploy[tool.type].push({ name: tool.name, dir: tool.dir, version: tool.version, tag: tool.tag });
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

// Turborepo does not see the pipeline files, so a pull request that only changes them
// would otherwise rehearse nothing and first run for real on main.
export function touchesPipeline(base: string | undefined, head: string | undefined, run: Run): boolean {
  if (!base || /^0+$/.test(base)) return false;
  const changed = run("git", ["diff", "--name-only", base, head || "HEAD", "--", ".github/workflows/deploy*.yml", ".github/scripts"]);
  return changed.trim() !== "";
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

// A skipped job is not a success: a deploy that was planned but did not run must fail the gate.
export function gateProblems(deploy: Partial<Plan["deploy"]>, needs: Needs): string[] {
  const isBad = (result: string | undefined) => result === "failure" || result === "cancelled";
  const problems = Object.entries(needs)
    .filter(([, { result }]) => isBad(result))
    .map(([job, { result }]) => `${job} ${result}`);
  // Without a successful plan nothing was planned, so the deploy checks below would pass vacuously.
  const planResult = needs.plan?.result;
  if (planResult !== "success" && !isBad(planResult)) {
    problems.push(`plan is ${planResult ?? "missing"}, so nothing was planned or deployed`);
  }
  for (const type of deployTypes) {
    const planned = deploy[type]?.length ?? 0;
    const result = needs[`deploy-${type}`]?.result;
    if (planned > 0 && result !== "success" && !isBad(result)) {
      problems.push(`deploy-${type} is ${result ?? "missing"} but ${planned} tool(s) are planned`);
    }
  }
  return problems;
}

const exec: Run = (command, args) =>
  execFileSync(command, args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });

const labels: Record<"merge" | "dry run", Record<Status, string>> = {
  merge: {
    deploy: "deploy",
    unbumped: "changed, but this version is already released: nothing is deployed",
    released: "already released",
    "not affected": "not affected",
  },
  "dry run": {
    deploy: "zip built, merging releases it",
    unbumped: "zip built, but this version is already released: merging deploys nothing",
    released: "zip built, this version is already released",
    "not affected": "not changed by this pull request",
  },
};

function report(
  result: Plan,
  tools: Tool[],
  context: { pullRequest: boolean; pipelineChanged: boolean },
  env: NodeJS.ProcessEnv,
): void {
  for (const tool of tools) {
    if (result.statuses[tool.dir] !== "unbumped") continue;
    console.log(
      `::warning title=Version not bumped::${tool.dir} changed but ${tool.tag} is already released, so nothing is deployed. Raise "version" in ${tool.dir}/package.json to release the change.`,
    );
  }
  const mode = context.pullRequest ? "dry run" : "merge";
  const note = context.pipelineChanged ? ", and the pipeline changed so every tool is built" : "";
  const summary = [
    `### Deploy plan${context.pullRequest ? ` (dry run: nothing is published${note})` : ""}`,
    "",
    "| Tool | Version | Tag | Result |",
    "| --- | --- | --- | --- |",
    ...tools.map((tool) => `| ${tool.dir} | ${tool.version} | \`${tool.tag}\` | ${labels[mode][result.statuses[tool.dir]]} |`),
    "",
  ].join("\n");
  const output = `deploy=${JSON.stringify(result.deploy)}`;
  if (env.GITHUB_OUTPUT) appendFileSync(env.GITHUB_OUTPUT, `${output}\n`);
  else console.log(output);
  if (env.GITHUB_STEP_SUMMARY) appendFileSync(env.GITHUB_STEP_SUMMARY, `${summary}\n`);
  else console.log(summary);
}

function planCommand(env: NodeJS.ProcessEnv): void {
  const tools = readTools();
  const pullRequest = env.GITHUB_EVENT_NAME === "pull_request";
  let affected: string[] = [];
  let pipelineChanged = false;
  try {
    affected = affectedDirs(env.TURBO_SCM_BASE, exec);
    pipelineChanged = pullRequest && touchesPipeline(env.TURBO_SCM_BASE, env.TURBO_SCM_HEAD, exec);
  } catch (error) {
    if (pullRequest) throw error;
    console.log(`::warning::Could not find the tools this change touches (${error}), so unreleased versions are still deployed but unbumped changes are not reported.`);
  }
  const candidates = pullRequest ? tools.filter((tool) => pipelineChanged || affected.includes(tool.dir)) : tools;
  const released = new Set(candidates.filter((tool) => releaseExists(tool.tag, exec)).map((tool) => tool.tag));
  report(plan({ tools, affected, released, pullRequest, pipelineChanged }), tools, { pullRequest, pipelineChanged }, env);
}

function gateCommand(env: NodeJS.ProcessEnv): void {
  if (!env.NEEDS) throw new Error("NEEDS is empty: the gate needs the results of the jobs it waits for");
  const needs: Needs = JSON.parse(env.NEEDS);
  const deploy: Partial<Plan["deploy"]> = JSON.parse(env.PLAN || "{}");
  for (const [job, { result }] of Object.entries(needs)) console.log(`${job}: ${result}`);
  const problems = gateProblems(deploy, needs);
  if (problems.length > 0) throw new Error(problems.join("; "));
}

function main(args: string[], env: NodeJS.ProcessEnv): void {
  if (args[0] === "plan") planCommand(env);
  else if (args[0] === "gate") gateCommand(env);
  else throw new Error("Usage: node .github/scripts/release.ts plan|gate");
}

// import.meta.main needs Node 24.2. An older Node would run nothing and exit 0, so compare the entry file instead.
const isEntry = import.meta.main ?? (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href);

if (isEntry) {
  try {
    main(process.argv.slice(2), process.env);
  } catch (error) {
    console.error(`${process.env.GITHUB_ACTIONS ? "::error::" : ""}${error instanceof Error ? error.message : error}`);
    process.exitCode = 1;
  }
}
