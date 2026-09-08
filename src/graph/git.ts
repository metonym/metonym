/**
 * Git integration for change detection.
 * Pure functions using Bun.spawnSync; never throws except for a malformed
 * `since` ref (see `changedFiles`).
 */

import { join } from "node:path";
import { isWithin, normalizeAbs, toProjectRelative } from "./paths";

export interface GitDiff {
  available: boolean;
  changedFiles: string[];
  base?: string;
  /** Git repository top-level (absolute path), when git is available. */
  topLevel?: string;
  /** True when `since` was given explicitly or a merge-base was found. */
  baseResolved: boolean;
}

function run(
  args: string[],
  cwd: string,
): { exitCode: number; stdout: string } {
  const result = Bun.spawnSync(["git", ...args], {
    cwd,
    stdio: ["pipe", "pipe", "pipe"],
  });
  return { exitCode: result.exitCode, stdout: result.stdout?.toString() ?? "" };
}

/**
 * Git prints paths relative to the repository top-level; every consumer of
 * `changedFiles` compares against paths relative to `root` (which may be a
 * subdirectory of the repo, e.g. a monorepo package). Re-anchor each line
 * to `root`, dropping anything that isn't actually under `topLevel`.
 */
function mapGitPaths(
  root: string,
  topLevel: string,
  lines: string[],
): string[] {
  const mapped: string[] = [];
  for (const line of lines) {
    if (!line) continue;
    const abs = normalizeAbs(join(topLevel, line));
    if (!isWithin(topLevel, abs)) continue;
    mapped.push(toProjectRelative(root, abs));
  }
  return mapped;
}

/**
 * Git repository top-level (absolute path) for `root`, or `undefined` when
 * `root` isn't inside a git work tree. Cheap: two `rev-parse` calls, no
 * diffing.
 */
export function gitTopLevel(root: string): string | undefined {
  const isRepoResult = run(["rev-parse", "--is-inside-work-tree"], root);
  if (isRepoResult.exitCode !== 0 || isRepoResult.stdout.trim() !== "true") {
    return undefined;
  }
  const topLevelResult = run(["rev-parse", "--show-toplevel"], root);
  return topLevelResult.exitCode === 0 ? topLevelResult.stdout.trim() : root;
}

/**
 * Detect changed files in a git repository.
 *
 * Strategy:
 * 1. Check if inside a git work tree
 * 2. Find base ref: merge-base(HEAD, since) ?? since ?? merge-base(HEAD, origin/HEAD|origin/master|origin/main)
 * 3. Collect: git diff --name-only [base], git diff --cached, git ls-files untracked
 * 4. Union and sort, all re-anchored to `root`
 *
 * `since` is always compared via its merge-base with HEAD (three-dot
 * semantics), matching the automatic path, so an explicit ref doesn't pull
 * in unrelated upstream commits. Falls back to the raw ref if no merge-base
 * exists (e.g. unrelated histories).
 */
export function changedFiles(root: string, since?: string): GitDiff {
  if (since?.startsWith("-")) {
    throw new Error("--since/--changed ref must not start with '-'");
  }

  const topLevel = gitTopLevel(root);
  if (topLevel === undefined) {
    return { available: false, changedFiles: [], baseResolved: false };
  }

  let base: string | undefined;
  let baseResolved = false;

  if (since !== undefined) {
    const mergeBaseResult = run(
      ["merge-base", "HEAD", "--end-of-options", since],
      root,
    );
    const found =
      mergeBaseResult.exitCode === 0 ? mergeBaseResult.stdout.trim() : "";
    base = found || since;
    baseResolved = true;
  } else {
    for (const candidate of ["origin/HEAD", "origin/master", "origin/main"]) {
      const mergeBaseResult = run(["merge-base", "HEAD", candidate], root);
      if (mergeBaseResult.exitCode === 0) {
        const found = mergeBaseResult.stdout.trim();
        if (found) {
          base = found;
          baseResolved = true;
          break;
        }
      }
    }
  }

  const changes = new Set<string>();

  const diffRef = base ?? "HEAD";
  const diffResult = run(
    ["diff", "--name-only", "--end-of-options", diffRef],
    root,
  );
  if (diffResult.exitCode === 0) {
    for (const p of mapGitPaths(
      root,
      topLevel,
      diffResult.stdout.trim().split("\n"),
    ))
      changes.add(p);
  }

  const cachedResult = run(["diff", "--name-only", "--cached"], root);
  if (cachedResult.exitCode === 0) {
    for (const p of mapGitPaths(
      root,
      topLevel,
      cachedResult.stdout.trim().split("\n"),
    ))
      changes.add(p);
  }

  const untrackedResult = run(
    ["ls-files", "--others", "--exclude-standard"],
    root,
  );
  if (untrackedResult.exitCode === 0) {
    for (const p of mapGitPaths(
      root,
      topLevel,
      untrackedResult.stdout.trim().split("\n"),
    ))
      changes.add(p);
  }

  return {
    available: true,
    changedFiles: Array.from(changes).sort(),
    base,
    topLevel,
    baseResolved,
  };
}
