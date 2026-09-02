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
});

describe("dogfooding", () => {
  test("metonym's own README passes metonym check", () => {
    const { exitCode, stderr } = runCli(["check"]);
    expect(exitCode).toBe(0);
    expect(stderr).toContain("README.md");
    expect(stderr).toMatch(/\d+ passed/);
    expect(stderr).not.toContain("✗");
  });
});
