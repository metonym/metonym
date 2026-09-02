/**
 * Git integration for change detection.
 * Pure functions using Bun.spawnSync; never throws.
 */

export interface GitDiff {
  available: boolean;
  changedFiles: string[];
  base?: string;
}

/**
 * Detect changed files in a git repository.
 *
 * Strategy:
 * 1. Check if inside a git work tree
 * 2. Find base ref: since ?? merge-base origin/HEAD ?? origin/master ?? origin/main
 * 3. Collect: git diff --name-only [base], git diff --cached, git ls-files untracked
 * 4. Union and sort
 */
export function changedFiles(root: string, since?: string): GitDiff {
  const isRepoResult = Bun.spawnSync(
    ["git", "rev-parse", "--is-inside-work-tree"],
    { cwd: root, stdio: ["pipe", "pipe", "pipe"] },
  );

  const isRepoOutput = isRepoResult.stdout?.toString().trim();
  if (isRepoResult.exitCode !== 0 || isRepoOutput !== "true") {
    return { available: false, changedFiles: [] };
  }

  let base: string | undefined = since;

  if (!base) {
    let mergeBaseResult = Bun.spawnSync(
      ["git", "merge-base", "HEAD", "origin/HEAD"],
      {
        cwd: root,
        stdio: ["pipe", "pipe", "pipe"],
      },
    );

    if (mergeBaseResult.exitCode === 0) {
      base = mergeBaseResult.stdout?.toString().trim();
    }

    if (!base) {
      mergeBaseResult = Bun.spawnSync(
        ["git", "merge-base", "HEAD", "origin/master"],
        {
          cwd: root,
          stdio: ["pipe", "pipe", "pipe"],
        },
      );

      if (mergeBaseResult.exitCode === 0) {
        base = mergeBaseResult.stdout?.toString().trim();
      }
    }

    if (!base) {
      mergeBaseResult = Bun.spawnSync(
        ["git", "merge-base", "HEAD", "origin/main"],
        {
          cwd: root,
          stdio: ["pipe", "pipe", "pipe"],
        },
      );

      if (mergeBaseResult.exitCode === 0) {
        base = mergeBaseResult.stdout?.toString().trim();
      }
    }
  }

  const changes = new Set<string>();

  // 1. git diff --name-only [base??HEAD]
  const diffRef = base ?? "HEAD";
  const diffResult = Bun.spawnSync(["git", "diff", "--name-only", diffRef], {
    cwd: root,
    stdio: ["pipe", "pipe", "pipe"],
  });

  if (diffResult.exitCode === 0) {
    const output = diffResult.stdout?.toString().trim();
    if (output) {
      for (const line of output.split("\n")) {
        if (line) changes.add(line);
      }
    }
  }

  // 2. git diff --name-only --cached
  const cachedResult = Bun.spawnSync(
    ["git", "diff", "--name-only", "--cached"],
    {
      cwd: root,
      stdio: ["pipe", "pipe", "pipe"],
    },
  );

  if (cachedResult.exitCode === 0) {
    const output = cachedResult.stdout?.toString().trim();
    if (output) {
      for (const line of output.split("\n")) {
        if (line) changes.add(line);
      }
    }
  }

  // 3. git ls-files --others --exclude-standard (untracked)
  const untrackedResult = Bun.spawnSync(
    ["git", "ls-files", "--others", "--exclude-standard"],
    {
      cwd: root,
      stdio: ["pipe", "pipe", "pipe"],
    },
  );

  if (untrackedResult.exitCode === 0) {
    const output = untrackedResult.stdout?.toString().trim();
    if (output) {
      for (const line of output.split("\n")) {
        if (line) changes.add(line);
      }
    }
  }

  return {
    available: true,
    changedFiles: Array.from(changes).sort(),
    base,
  };
}
