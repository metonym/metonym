/**
 * End-to-end `metonym check` bench: scan → extractCached → generate → runCached.
 * Cold vs warm cache. Executes examples (unlike pipeline.bench.ts).
 *
 * One-off phase timings only. Do not wrap bun test in ostia — M writes
 * thousands of test files and an ostia loop would dominate the machine.
 *
 * Usage: bun bench/check.bench.ts [S|M]
 */

import { readdir, utimes } from "node:fs/promises";
import { clearCache, extractCached } from "../src/cache/extract-cache";
import { runCached } from "../src/cache/result-cache";
import { generate } from "../src/emit/generate";
import type { Project, RunResult } from "../src/ir/types";
import { scan } from "../src/scan/scan";
import { generateRepo } from "./gen";

type Size = "S" | "M";

const SCAN_CONFIG = { analysis: "shallow" as const };

async function rmRecursive(path: string): Promise<void> {
  await Bun.spawn(["rm", "-rf", path], {
    stdio: ["ignore", "ignore", "ignore"],
  }).exited;
}

interface Phases {
  scan: number;
  extractCached: number;
  generate: number;
  runCached: number;
  total: number;
}

async function checkOnce(root: string): Promise<{
  phases: Phases;
  result: RunResult;
  examples: number;
}> {
  const t0 = performance.now();
  const project: Project = await scan({ root, config: SCAN_CONFIG });
  const t1 = performance.now();
  const docs = await extractCached(project);
  const t2 = performance.now();
  const emit = { jsxImportSource: project.config.jsxImportSource };
  generate(docs, emit);
  const t3 = performance.now();
  const result = await runCached(docs, {
    outDir: `${project.root}/${project.config.outDir}`,
    emit,
  });
  const t4 = performance.now();

  return {
    phases: {
      scan: t1 - t0,
      extractCached: t2 - t1,
      generate: t3 - t2,
      runCached: t4 - t3,
      total: t4 - t0,
    },
    result,
    examples: docs.examples.length,
  };
}

function printBreakdown(
  size: Size,
  label: "cold" | "warm",
  phases: Phases,
  result: RunResult,
): void {
  const row = (name: string, ms: number) =>
    console.log(`  ${name.padEnd(16)} ${ms.toFixed(2)}`);

  console.log(`Size ${size}  ${label}`);
  row("scan", phases.scan);
  row("extractCached", phases.extractCached);
  row("generate", phases.generate);
  row("runCached", phases.runCached);
  row("total", phases.total);
  console.log(
    `  ${"passed".padEnd(16)} ${result.totals.passed}` +
      `  failed ${result.totals.failed}` +
      `  cached ${result.totals.cached ?? 0}`,
  );
}

function assertPassed(size: Size, label: string, result: RunResult): void {
  if (result.totals.failed === 0) return;
  const fails = result.results.filter((r) => r.status === "failed").slice(0, 5);
  for (const r of fails) {
    console.error(
      `  FAIL ${r.docFile} ${r.title}: ${r.failure?.message ?? ""}`,
    );
  }
  throw new Error(
    `check ${size} ${label}: ${result.totals.failed} example(s) failed`,
  );
}

/**
 * Freshly generated fixtures are newer than the extract cache's racy
 * window, which would force the content-hash path on every "warm" run.
 * Backdate them so warm measures a settled tree, as a real repo would be.
 */
async function backdate(root: string): Promise<void> {
  const settled = new Date(Date.now() - 60_000);
  const entries = await readdir(root, { recursive: true, withFileTypes: true });
  await Promise.all(
    entries
      .filter((e) => e.isFile())
      .map((e) => utimes(`${e.parentPath}/${e.name}`, settled, settled)),
  );
}

const arg = Bun.argv[2];
const SIZES: Size[] = arg === "S" || arg === "M" ? [arg] : ["S", "M"];

console.log("check phase breakdown (single run, ms):");

for (const size of SIZES) {
  const root = `${import.meta.dir}/tmp/check-${size}`;
  await rmRecursive(root);
  const generated = await generateRepo(root, size);
  await backdate(root);
  console.log(
    `\nfixture ${size}: ${generated.files} files, ${generated.examples} examples`,
  );

  await clearCache(root);
  const cold = await checkOnce(root);
  printBreakdown(size, "cold", cold.phases, cold.result);
  console.log(`  ${"examples".padEnd(16)} ${cold.examples}`);
  assertPassed(size, "cold", cold.result);

  const warm = await checkOnce(root);
  printBreakdown(size, "warm", warm.phases, warm.result);
  assertPassed(size, "warm", warm.result);
}
