import { spawnSync } from "node:child_process";
import { mkdtempSync, rmdirSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

function lint(message: string) {
  return spawnSync("node_modules/.bin/commitlint", [], {
    encoding: "utf8",
    input: message,
  });
}

function lintEdit(message: string) {
  const directory = mkdtempSync(join(tmpdir(), "devtools-commitlint-"));
  const file = join(directory, "message");
  try {
    writeFileSync(file, message);
    return spawnSync("node_modules/.bin/commitlint", ["--edit", file], {
      encoding: "utf8",
    });
  } finally {
    unlinkSync(file);
    rmdirSync(directory);
  }
}

describe("commit messages", () => {
  it.each(["feat", "fix", "doc", "chore"])("accepts the %s type", (type) => {
    const result = lint(`${type}: DEV-00000 add workspace setup`);
    expect(result.status, result.stderr).toBe(0);
  });

  it.each(["\n", "\r\n"])("accepts a final line ending %j", (ending) => {
    const result = lint(`feat: DEV-00000 add workspace setup${ending}`);
    expect(result.status, result.stderr).toBe(0);
  });

  it("accepts a Git commit message file ending in a newline", () => {
    const result = lintEdit("feat: DEV-00000 add workspace setup\n");
    expect(result.status, result.stderr).toBe(0);
  });

  it("rejects a Git commit message file with a body", () => {
    const result = lintEdit("feat: DEV-00000 add workspace setup\n\nextra body\n");
    expect(result.status, result.stderr).toBe(1);
  });

  it.each([
    "docs: DEV-00000 add workspace setup",
    "feat(scope): DEV-00000 add workspace setup",
    "feat DEV-00000 add workspace setup",
    "feat: DEV-0000 add workspace setup",
    "feat: DEV-000000 add workspace setup",
    "feat: DEV-00000",
    "feat: DEV-00000 ",
    "Merge branch main",
    "feat: DEV-00000 add workspace setup\n\nextra body",
  ])("rejects invalid message %j", (message) => {
    const result = lint(message);
    expect(result.error).toBeUndefined();
    expect(result.status, result.stderr).toBe(1);
  });

  it("accepts a 120-character header and rejects a 121-character header", () => {
    const prefix = "feat: DEV-00000 ";
    expect(lint(prefix + "a".repeat(120 - prefix.length) + "\n").status).toBe(0);
    expect(lint(prefix + "a".repeat(121 - prefix.length) + "\n").status).toBe(1);
  });
});
