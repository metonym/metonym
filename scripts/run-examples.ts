/**
 * Discover each recipe under examples/, bun-install it, run its CI script.
 * Recipes depend on the built artifact at package/, so `bun run build` first.
 *
 * The script name is a CLI verb (`check`, `coverage`, `extract`) so the
 * package.json a user copies matches what they would add to their own CI.
 */

import { existsSync } from "node:fs";
import { readdir } from "node:fs/promises";
import { join } from "node:path";

export const MISSING_ARTIFACT =
  "error: built package/ is missing; run `bun run build` first\n";

export interface Io {
  stdout: { write(chunk: string): void };
  stderr: { write(chunk: string): void };
}

const CI_SCRIPTS = ["check", "coverage", "extract"] as const;

export interface Recipe {
  name: string;
  dir: string;
  /** npm script name to run (`check`, `coverage`, or `extract`). */
  script: string | undefined;
}

const defaultIo: Io = {
  stdout: process.stdout,
  stderr: process.stderr,
};

export function artifactPresent(root: string): boolean {
  return existsSync(join(root, "package", "package.json"));
}

export async function discoverRecipes(examplesDir: string): Promise<Recipe[]> {
  const entries = await readdir(examplesDir, { withFileTypes: true }).catch(
    () => null,
  );
  if (entries === null) return [];

  const recipes: Recipe[] = [];

  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    if (!entry.isDirectory()) continue;
    const dir = join(examplesDir, entry.name);
    const pkgPath = join(dir, "package.json");
    let pkg: unknown;
    try {
      pkg = await Bun.file(pkgPath).json();
    } catch {
      continue;
    }

    recipes.push({ name: entry.name, dir, script: ciScript(pkg) });
  }

  return recipes;
}

function ciScript(pkg: unknown): string | undefined {
  if (typeof pkg !== "object" || pkg === null) return undefined;
  if (!("scripts" in pkg)) return undefined;
  const scripts = pkg.scripts;
  if (typeof scripts !== "object" || scripts === null) return undefined;
  const map = scripts as Record<string, unknown>;
  for (const name of CI_SCRIPTS) {
    const cmd = map[name];
    if (typeof cmd === "string" && cmd.length > 0) return name;
  }
  return undefined;
}

function prefixLines(name: string, text: string): string {
  if (text.length === 0) return "";
  const endsWithNl = text.endsWith("\n");
  const lines = (endsWithNl ? text.slice(0, -1) : text).split("\n");
  const prefixed = lines.map((line) => `[${name}] ${line}`).join("\n");
  return endsWithNl ? `${prefixed}\n` : prefixed;
}

async function spawnIn(
  cmd: string[],
  cwd: string,
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  const proc = Bun.spawn(cmd, {
    cwd,
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { exitCode, stdout, stderr };
}

async function runRecipe(
  recipe: Recipe,
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  const install = await spawnIn(["bun", "install"], recipe.dir);
  if (install.exitCode !== 0) {
    return {
      exitCode: install.exitCode,
      stdout: install.stdout,
      stderr: `bun install failed\n${install.stderr}`,
    };
  }
  const script = recipe.script ?? "check";
  const run = await spawnIn(["bun", "run", script], recipe.dir);
  return {
    exitCode: run.exitCode,
    stdout: `${install.stdout}${run.stdout}`,
    stderr: `${install.stderr}${run.stderr}`,
  };
}

export async function main(root: string, io: Io = defaultIo): Promise<number> {
  if (!artifactPresent(root)) {
    io.stderr.write(MISSING_ARTIFACT);
    return 1;
  }

  const recipes = await discoverRecipes(join(root, "examples"));
  if (recipes.length === 0) {
    io.stderr.write("error: no example recipes found under examples/\n");
    return 1;
  }

  const incomplete = recipes.filter((r) => r.script === undefined);
  if (incomplete.length > 0) {
    for (const r of incomplete) {
      io.stderr.write(
        `error: ${r.name} needs a "check", "coverage", or "extract" script in package.json\n`,
      );
    }
    return 1;
  }

  const failures: string[] = [];
  for (const recipe of recipes) {
    const result = await runRecipe(recipe);
    io.stdout.write(prefixLines(recipe.name, result.stdout));
    io.stderr.write(prefixLines(recipe.name, result.stderr));
    io.stderr.write(`[${recipe.name}] exit ${result.exitCode}\n`);
    if (result.exitCode !== 0) failures.push(recipe.name);
  }

  if (failures.length > 0) {
    io.stderr.write(
      `error: ${failures.length} example(s) failed: ${failures.join(", ")}\n`,
    );
    return 1;
  }

  io.stderr.write(`${recipes.length} example(s) passed\n`);
  return 0;
}

if (import.meta.main) {
  process.exitCode = await main(join(import.meta.dir, ".."));
}
