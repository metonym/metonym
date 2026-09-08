/**
 * End-to-end: fixture project → CLI → verified output and exit codes,
 * plus the dogfooding guarantee that metonym's own README passes.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const REPO = join(import.meta.dir, "..");
const CLI = join(REPO, "src/cli/main.ts");

function runCli(args: string[], cwd?: string) {
  const proc = Bun.spawnSync([process.execPath, CLI, ...args], {
    cwd: cwd ?? REPO,
    stdout: "pipe",
    stderr: "pipe",
  });
  return {
    exitCode: proc.exitCode,
    stdout: proc.stdout.toString(),
    stderr: proc.stderr.toString(),
  };
}

describe("e2e fixture project", () => {
  let root: string;

  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), "metonym-e2e-"));
    await Bun.write(
      join(root, "package.json"),
      JSON.stringify({ name: "demo-pkg", exports: { ".": "./src/index.ts" } }),
    );
    await Bun.write(
      join(root, "src/index.ts"),
      [
        "/**",
        " * Adds two numbers.",
        " *",
        " * @example",
        " * ```ts",
        ' * import { add } from "demo-pkg"',
        " * expect(add(2, 3)).toBe(5)",
        " * ```",
        " */",
        "export function add(a: number, b: number): number {",
        "  return a + b;",
        "}",
        "",
      ].join("\n"),
    );
    await Bun.write(
      join(root, "README.md"),
      [
        "# demo-pkg",
        "",
        "## Quick start",
        "",
        "```ts",
        'import { add } from "demo-pkg"',
        "expect(add(2, 3)).toBe(5)",
        "```",
        "",
        "## Broken claim",
        "",
        "```ts",
        'import { add } from "demo-pkg"',
        "",
        "expect(add(2, 3)).toBe(6)",
        "```",
        "",
        "## Future API",
        "",
        "```ts pending",
        'import { multiply } from "demo-pkg"',
        "```",
        "",
        "```json",
        '{ "not": "executable" }',
        "```",
        "",
      ].join("\n"),
    );
  });

  afterAll(async () => {
    await rm(root, { recursive: true, force: true });
  });

  test("check reports pass/fail/pending, remaps to doc line, exits 1", () => {
    const { exitCode, stderr } = runCli(["check", `--root=${root}`]);
    expect(exitCode).toBe(1);
    expect(stderr).toContain("✓ Quick start › example 1");
    expect(stderr).toContain("✗ Broken claim › example 1");
    expect(stderr).toContain("○ Future API › example 1");
    // The failing expect is body line 3 of a block whose body starts at
    // README.md:13 → remapped doc line 15.
    expect(stderr).toContain("README.md:15");
    expect(stderr).toContain("Expected: 6");
    expect(stderr).toContain("Received: 5");
    expect(stderr).toContain("✓ add › example 1"); // JSDoc example
  });

  test("check --filter narrows to matching examples and exits 0", () => {
    const { exitCode, stderr } = runCli([
      "check",
      `--root=${root}`,
      "--filter=Quick start",
    ]);
    expect(exitCode).toBe(0);
    expect(stderr).toContain("Quick start");
    expect(stderr).not.toContain("Broken claim");
  });

  test("extract --format=json emits the IR without executing", () => {
    const { exitCode, stdout } = runCli([
      "extract",
      `--root=${root}`,
      "--format=json",
    ]);
    expect(exitCode).toBe(0);
    const ir = JSON.parse(stdout);
    expect(ir.irVersion).toBe(1);
    expect(ir.documents.length).toBe(2); // README + jsdoc doc
    expect(ir.examples.length).toBe(4);
    expect(ir.symbols.map((s: { name: string }) => s.name)).toContain("add");
    const kinds = ir.examples.map((e: { kind: string }) => e.kind).sort();
    expect(kinds).toEqual(["assertion", "assertion", "assertion", "pending"]);
  });

  test("extract --format=json replaces the absolute root with '.'", () => {
    const { exitCode, stdout } = runCli([
      "extract",
      `--root=${root}`,
      "--format=json",
    ]);
    expect(exitCode).toBe(0);
    const ir = JSON.parse(stdout);
    expect(ir.root).toBe(".");
  });

  test("extract --format=jsonl emits one example per line", () => {
    const { exitCode, stdout } = runCli([
      "extract",
      `--root=${root}`,
      "--format=jsonl",
    ]);
    expect(exitCode).toBe(0);
    const lines = stdout.trim().split("\n");
    expect(lines.length).toBe(4);
    for (const line of lines) expect(() => JSON.parse(line)).not.toThrow();
  });

  test("extract --no-config skips a broken metonym.config.ts", async () => {
    const configRoot = await mkdtemp(join(tmpdir(), "metonym-e2e-noconfig-"));
    try {
      await Bun.write(
        join(configRoot, "package.json"),
        JSON.stringify({ name: "demo-pkg" }),
      );
      await Bun.write(join(configRoot, "README.md"), "# demo-pkg\n");
      await Bun.write(
        join(configRoot, "metonym.config.ts"),
        "throw new Error('boom');\n",
      );

      const { exitCode } = runCli([
        "extract",
        `--root=${configRoot}`,
        "--format=json",
        "--no-config",
      ]);
      expect(exitCode).toBe(0);
    } finally {
      await rm(configRoot, { recursive: true, force: true });
    }
  });

  test("impact: ./relative, absolute, and bare relative path args produce identical JSON", () => {
    const bare = runCli([
      "impact",
      `--root=${root}`,
      "--format=json",
      "src/index.ts",
    ]);
    const dotRelative = runCli([
      "impact",
      `--root=${root}`,
      "--format=json",
      "./src/index.ts",
    ]);
    const absolute = runCli([
      "impact",
      `--root=${root}`,
      "--format=json",
      `${root}/src/index.ts`,
    ]);

    expect(bare.exitCode).toBe(0);
    expect(dotRelative.exitCode).toBe(0);
    expect(absolute.exitCode).toBe(0);
    expect(JSON.parse(dotRelative.stdout)).toEqual(JSON.parse(bare.stdout));
    expect(JSON.parse(absolute.stdout)).toEqual(JSON.parse(bare.stdout));
  });

  test("build --run --out-dir doesn't let generated-test pruning delete its own rendered output", async () => {
    // `--out-dir` means "where do rendered docs go" for `build`, not "where
    // do generated tests go" — if it leaked into the latter too, `--run`'s
    // stale-file sync would delete a format's just-rendered file the moment
    // a second `build` call (or even the same one) synced tests into the
    // same directory.
    const outDir = join(root, "build-out");
    const jsonResult = runCli([
      "build",
      `--root=${root}`,
      "--format=json",
      "--run",
      `--out-dir=${outDir.replace(`${root}/`, "")}`,
    ]);
    expect(jsonResult.exitCode).toBe(0);
    expect(await Bun.file(join(outDir, "metonym.ir.json")).exists()).toBe(true);

    const markdownResult = runCli([
      "build",
      `--root=${root}`,
      "--format=markdown",
      "--run",
      `--out-dir=${outDir.replace(`${root}/`, "")}`,
    ]);
    expect(markdownResult.exitCode).toBe(0);

    // The json render from the previous call must survive the markdown
    // call's `--run` test sync into the same --out-dir.
    expect(await Bun.file(join(outDir, "metonym.ir.json")).exists()).toBe(true);
    expect(await Bun.file(join(outDir, "README.md")).exists()).toBe(true);
  });

  test("build --out-dir with an absolute path writes and prints there, not under the project root", async () => {
    const absOutDir = await mkdtemp(join(tmpdir(), "metonym-out-"));
    const result = runCli([
      "build",
      `--root=${root}`,
      "--format=json",
      `--out-dir=${absOutDir}`,
    ]);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain(join(absOutDir, "metonym.ir.json"));
    expect(await Bun.file(join(absOutDir, "metonym.ir.json")).exists()).toBe(
      true,
    );
    await rm(absOutDir, { recursive: true, force: true });
  });
});

describe("CLI usage errors", () => {
  let root: string;

  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), "metonym-usage-e2e-"));
    await Bun.write(
      join(root, "package.json"),
      JSON.stringify({ name: "demo-pkg" }),
    );
    await Bun.write(
      join(root, "README.md"),
      ["# demo-pkg", "", "```ts", "expect(1).toBe(1);", "```", ""].join("\n"),
    );
  });

  afterAll(async () => {
    await rm(root, { recursive: true, force: true });
  });

  test("unknown long flag exits 2", () => {
    const { exitCode, stderr } = runCli(["check", `--root=${root}`, "--bogus"]);
    expect(exitCode).toBe(2);
    expect(stderr).toContain("unknown flag --bogus");
  });

  test("unknown short flag exits 2, never treated as a path", () => {
    const { exitCode, stderr } = runCli(["check", `--root=${root}`, "-f"]);
    expect(exitCode).toBe(2);
    expect(stderr).toContain("unknown flag -f");
  });

  test("invalid --reporter value exits 2", () => {
    const { exitCode, stderr } = runCli([
      "check",
      `--root=${root}`,
      "--reporter",
      "bogus",
    ]);
    expect(exitCode).toBe(2);
    expect(stderr).toContain("invalid --reporter=bogus");
  });

  test("--reporter json with a space consumes the next token as its value", () => {
    const spaced = runCli([
      "check",
      `--root=${root}`,
      "--full",
      "--reporter",
      "json",
    ]);
    const equals = runCli([
      "check",
      `--root=${root}`,
      "--full",
      "--reporter=json",
    ]);
    expect(spaced.exitCode).toBe(equals.exitCode);
    // Strip timing, which legitimately varies run to run.
    const stable = (raw: string) => {
      const parsed = JSON.parse(raw);
      for (const r of parsed.results) r.durationMs = 0;
      parsed.totals.durationMs = 0;
      return parsed;
    };
    expect(stable(spaced.stdout)).toEqual(stable(equals.stdout));
  });

  test("path arguments matching no files exit 2 with a clear message", () => {
    const { exitCode, stderr } = runCli([
      "check",
      `--root=${root}`,
      "does/not/exist.md",
    ]);
    expect(exitCode).toBe(2);
    expect(stderr).toContain(
      "no documentation or source files matched: does/not/exist.md",
    );
  });

  test("--help still exits 0", () => {
    const { exitCode, stdout } = runCli(["--help"]);
    expect(exitCode).toBe(0);
    expect(stdout).toContain("metonym");
  });
});

describe("group= doc-line remap", () => {
  test("failure in the 2nd+ example of a group remaps to the correct README line", async () => {
    const root = await mkdtemp(join(tmpdir(), "metonym-group-e2e-"));
    try {
      await Bun.write(
        join(root, "package.json"),
        JSON.stringify({ name: "demo-pkg" }),
      );
      const lines = [
        "# demo-pkg",
        "",
        "## Group demo",
        "",
        "```ts group=g",
        "const a = 1;",
        "expect(a).toBe(1);",
        "```",
        "",
        "```ts group=g",
        "const b = 2;",
        "expect(b).toBe(3);",
        "```",
        "",
      ];
      // 1-indexed line of `expect(b).toBe(3);` (the 2nd body line of the
      // 2nd group member), computed from the array above rather than
      // hardcoded so the assertion tracks the fixture if it's edited.
      const failingLine = lines.indexOf("expect(b).toBe(3);") + 1;
      await Bun.write(join(root, "README.md"), lines.join("\n"));

      const { exitCode, stdout } = runCli([
        "check",
        `--root=${root}`,
        "--reporter=json",
      ]);
      expect(exitCode).toBe(1);
      const result = JSON.parse(stdout);
      // Both group members' testcases report status "failed" (they share one
      // `test()` scope), but only the entry whose generated line range
      // contains the actual failure gets remapped `doc` info.
      const remapped = result.results.find(
        (r: { failure?: { doc?: unknown } }) => r.failure?.doc,
      );
      expect(remapped).toBeDefined();
      expect(remapped.failure.doc.file).toBe("README.md");
      expect(remapped.failure.doc.line).toBe(failingLine);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe("extraction warnings", () => {
  test("metonym extract prints a warning for a typo'd attribute and still exits 0", async () => {
    const root = await mkdtemp(join(tmpdir(), "metonym-e2e-warnings-"));
    try {
      await Bun.write(
        join(root, "package.json"),
        JSON.stringify({ name: "warn-pkg" }),
      );
      await Bun.write(
        join(root, "README.md"),
        ["# warn-pkg", "", "```ts no_run", "code()", "```", ""].join("\n"),
      );

      const { exitCode, stderr } = runCli([
        "extract",
        `--root=${root}`,
        "--format=json",
      ]);
      expect(exitCode).toBe(0);
      expect(stderr).toContain("warning:");
      expect(stderr).toContain('unknown fence attribute "no_run"');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe("git subdirectory project", () => {
  test("check --changed=HEAD --analysis=shallow selects the one example from a monorepo subpackage", async () => {
    const repoRoot = await mkdtemp(join(tmpdir(), "metonym-subpkg-"));
    try {
      const git = (args: string[]) =>
        Bun.spawnSync(["git", ...args], { cwd: repoRoot });
      git(["init", "-q", "-b", "main"]);
      git(["config", "user.email", "a@b.com"]);
      git(["config", "user.name", "a"]);

      const pkgRoot = join(repoRoot, "packages/foo");
      await Bun.write(
        join(pkgRoot, "package.json"),
        JSON.stringify({ name: "foo-pkg", exports: { ".": "./src/index.ts" } }),
      );
      await Bun.write(
        join(pkgRoot, "src/index.ts"),
        [
          "export function add(a: number, b: number): number {",
          "  return a + b;",
          "}",
          "",
        ].join("\n"),
      );
      await Bun.write(
        join(pkgRoot, "README.md"),
        [
          "# foo-pkg",
          "",
          "```ts",
          'import { add } from "foo-pkg"',
          "expect(add(2, 3)).toBe(5)",
          "```",
          "",
        ].join("\n"),
      );

      git(["add", "-A"]);
      git(["commit", "-qm", "init"]);

      // Edit the source file after the commit — this is what --changed=HEAD
      // should pick up, re-anchored to `pkgRoot`, not the repo top-level.
      await Bun.write(
        join(pkgRoot, "src/index.ts"),
        [
          "export function add(a: number, b: number): number {",
          "  return a + b; // touched",
          "}",
          "",
        ].join("\n"),
      );

      const { exitCode, stderr } = runCli(
        ["check", "--changed=HEAD", "--analysis=shallow"],
        pkgRoot,
      );
      expect(exitCode).toBe(0);
      expect(stderr).toContain("1/1 examples selected");
    } finally {
      await rm(repoRoot, { recursive: true, force: true });
    }
  });
});

describe("coverage command", () => {
  let root: string;

  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), "metonym-coverage-e2e-"));
    await Bun.write(
      join(root, "package.json"),
      JSON.stringify({
        name: "cov-pkg",
        exports: { ".": "./src/index.ts" },
        metonym: { coverage: { minDocumented: 100 } },
      }),
    );
    await Bun.write(
      join(root, "src/index.ts"),
      [
        "export function add(a: number, b: number): number {",
        "  return a + b;",
        "}",
        "",
        "export function subtract(a: number, b: number): number {",
        "  return a - b;",
        "}",
        "",
      ].join("\n"),
    );
    await Bun.write(
      join(root, "README.md"),
      [
        "# cov-pkg",
        "",
        "```ts",
        'import { add } from "cov-pkg"',
        "expect(add(2, 3)).toBe(5)",
        "```",
        "",
      ].join("\n"),
    );
  });

  afterAll(async () => {
    await rm(root, { recursive: true, force: true });
  });

  test("--reporter=json --check exits 1 and reports gates.pass=false on a failing gate", () => {
    // `subtract` is neither called from README nor JSDoc'd, so documented
    // coverage is 50% — below the configured minDocumented: 100 gate.
    const { exitCode, stdout } = runCli([
      "coverage",
      `--root=${root}`,
      "--reporter=json",
      "--check",
    ]);
    expect(exitCode).toBe(1);
    const result = JSON.parse(stdout);
    expect(result.gates).toBeDefined();
    expect(result.gates.pass).toBe(false);
    expect(result.gates.failures.length).toBeGreaterThanOrEqual(1);
    expect(result.exercised).toEqual(
      expect.arrayContaining([expect.stringContaining("add")]),
    );
  });

  test("--reporter=json without --check has no gates key", () => {
    const { exitCode, stdout } = runCli([
      "coverage",
      `--root=${root}`,
      "--reporter=json",
    ]);
    expect(exitCode).toBe(0);
    const result = JSON.parse(stdout);
    expect(result.gates).toBeUndefined();
  });
});

describe("dogfooding", () => {
  test("metonym's own README passes metonym check", () => {
    const { exitCode, stderr } = runCli(["check"]);
    expect(exitCode).toBe(0);
    expect(stderr).toContain("src/README.md");
    expect(stderr).toMatch(/\d+ passed/);
    expect(stderr).not.toContain("✗");
  });
});
