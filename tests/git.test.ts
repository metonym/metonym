import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { changedFiles } from "../src/graph/git";

function git(args: string[], cwd: string): void {
  const result = Bun.spawnSync(["git", ...args], {
    cwd,
    stdio: ["pipe", "pipe", "pipe"],
  });
  if (result.exitCode !== 0) {
    throw new Error(
      `git ${args.join(" ")} failed: ${result.stderr?.toString()}`,
    );
  }
}

function initRepo(dir: string): void {
  git(["init", "-q", "-b", "main"], dir);
  git(["config", "user.email", "a@b.com"], dir);
  git(["config", "user.name", "a"], dir);
}

describe("changedFiles", () => {
  test("explicit ref: diffs from the merge-base (three-dot semantics), not a raw two-dot diff", async () => {
    const repo = mkdtempSync(join(tmpdir(), "git-test-"));
    try {
      initRepo(repo);
      await Bun.write(join(repo, "a.ts"), "export const a = 1;\n");
      git(["add", "-A"], repo);
      git(["commit", "-qm", "init"], repo);

      git(["checkout", "-qb", "feature"], repo);
      await Bun.write(join(repo, "b.ts"), "export const b = 1;\n");
      git(["add", "-A"], repo);
      git(["commit", "-qm", "feature change"], repo);

      git(["checkout", "-q", "main"], repo);
      await Bun.write(join(repo, "c.ts"), "export const c = 1;\n");
      git(["add", "-A"], repo);
      git(["commit", "-qm", "main change"], repo);

      git(["checkout", "-q", "feature"], repo);

      const result = changedFiles(repo, "main");
      expect(result.changedFiles).toContain("b.ts");
      expect(result.changedFiles).not.toContain("c.ts");
      expect(result.baseResolved).toBe(true);
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  test("subdirectory root: paths are relative to root, not the repo top-level", async () => {
    const repo = mkdtempSync(join(tmpdir(), "git-test-"));
    try {
      initRepo(repo);
      await Bun.write(
        join(repo, "packages/foo/src/index.ts"),
        "export const x = 1;\n",
      );
      git(["add", "-A"], repo);
      git(["commit", "-qm", "init"], repo);

      await Bun.write(
        join(repo, "packages/foo/src/index.ts"),
        "export const x = 2;\n",
      );

      const result = changedFiles(join(repo, "packages/foo"), "HEAD");
      expect(result.changedFiles).toContain("src/index.ts");
      expect(result.changedFiles).not.toContain("packages/foo/src/index.ts");
      expect(result.topLevel).toBeDefined();
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  test("baseResolved is false when no origin/* exists and no since is given", async () => {
    const repo = mkdtempSync(join(tmpdir(), "git-test-"));
    try {
      initRepo(repo);
      await Bun.write(join(repo, "a.ts"), "export const a = 1;\n");
      git(["add", "-A"], repo);
      git(["commit", "-qm", "init"], repo);

      const result = changedFiles(repo);
      expect(result.baseResolved).toBe(false);
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  test("rejects a since ref that starts with '-'", () => {
    const repo = mkdtempSync(join(tmpdir(), "git-test-"));
    try {
      initRepo(repo);
      expect(() => changedFiles(repo, "--evil")).toThrow(
        "--since/--changed ref must not start with '-'",
      );
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  test("rename: a git-mv shows up as both the old and new path", async () => {
    const repo = mkdtempSync(join(tmpdir(), "git-test-"));
    try {
      initRepo(repo);
      await Bun.write(
        join(repo, "a.ts"),
        "export const a = 1;\n// padding to pass git's rename similarity threshold\n",
      );
      git(["add", "-A"], repo);
      git(["commit", "-qm", "init"], repo);

      git(["mv", "a.ts", "b.ts"], repo);
      git(["commit", "-qm", "rename"], repo);

      const result = changedFiles(repo, "HEAD~1");
      expect(result.changedFiles).toContain("a.ts");
      expect(result.changedFiles).toContain("b.ts");
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });
});
