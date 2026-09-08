#!/usr/bin/env bun

/**
 * metonym CLI.
 *   metonym check [paths…]   extract + run + report (exit 1 on failures)
 *   metonym test  [paths…]   alias of check
 *   metonym extract          emit IR or generated tests (--format=json|jsonl|tests)
 *   metonym build            render docs (--format=markdown|html|json|jsonl)
 */

import * as fs from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { resolveAnalysisMode } from "../analysis/provider";
import { extractCachedWithKeys } from "../cache/extract-cache";
import { writeAtomic } from "../cache/fs";
import { runCached } from "../cache/result-cache";
import { generate } from "../emit/generate";
import { extract } from "../extract";
import {
  type DocumentationSet,
  type Project,
  type RunResult,
  TOOL_NAME,
  TOOL_VERSION,
} from "../ir/types";
import { scan } from "../scan/scan";
import { c } from "./colors";
import { reportPretty } from "./reporter";
import { selectExamples } from "./select";
import { UsageError } from "./usage-error";

// Command-specific modules are dynamically imported at their one call site
// instead of statically here. `analysis/ts-provider.ts` alone is ~900 lines
// (TypeScript-compiler-backed deep analysis); graph/impact, graph/emit,
// the renderers, and watch add up to roughly as much again. Every one of
// those is dead weight for the common case (a plain `check`/`extract` run,
// or `--help`/`--version`), so deferring them to only the command branch
// that needs them keeps startup cost proportional to what's actually run.

interface Args {
  command: string;
  paths: string[];
  flags: Map<string, string | true>;
}

// `no-config` is added by a sibling PR; listing it here as known is
// harmless even before that lands.
const KNOWN_FLAGS = new Set([
  "help",
  "version",
  "root",
  "out-dir",
  "analysis",
  "full",
  "format",
  "filter",
  "only",
  "list",
  "failed",
  "reporter",
  "changed",
  "watch",
  "run",
  "check",
  "since",
  "no-config",
  "timeout",
  "bail",
]);

// `--changed` and `--bail` deliberately excluded: they keep their optional
// `=<ref>`/`=<n>` form only, since a bare flag is meaningful on its own
// (all changed examples; stop after the first failure).
const VALUE_FLAGS = new Set([
  "root",
  "out-dir",
  "analysis",
  "format",
  "filter",
  "only",
  "reporter",
  "since",
  "timeout",
]);

// `--only` is repeatable: a second occurrence appends to the first
// (comma-joined) rather than overwriting it, so `--only=a --only=b` and
// `--only=a,b` mean the same thing.
function setFlagValue(
  flags: Map<string, string | true>,
  name: string,
  value: string,
): void {
  if (name === "only") {
    const existing = flags.get(name);
    flags.set(
      name,
      typeof existing === "string" ? `${existing},${value}` : value,
    );
    return;
  }
  flags.set(name, value);
}

function isPositiveInteger(value: string | true): boolean {
  if (typeof value !== "string" || !/^\d+$/.test(value)) return false;
  return Number(value) > 0;
}

function parseArgs(argv: string[]): Args {
  // A leading flag (e.g. `metonym --help`) means no command was given —
  // don't swallow it as the command positional.
  const hasCommand = argv.length > 0 && !argv[0].startsWith("-");
  const command = hasCommand ? argv[0] : "check";
  const rest = hasCommand ? argv.slice(1) : argv;
  const paths: string[] = [];
  const flags = new Map<string, string | true>();

  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    if (a.startsWith("--")) {
      const eq = a.indexOf("=");
      const name = eq === -1 ? a.slice(2) : a.slice(2, eq);
      if (!KNOWN_FLAGS.has(name)) {
        throw new UsageError(`unknown flag --${name}\nrun 'metonym --help'`);
      }
      if (eq !== -1) {
        setFlagValue(flags, name, a.slice(eq + 1));
        continue;
      }
      if (
        VALUE_FLAGS.has(name) &&
        i + 1 < rest.length &&
        !rest[i + 1].startsWith("-")
      ) {
        setFlagValue(flags, name, rest[i + 1]);
        i++;
        continue;
      }
      flags.set(name, true);
    } else if (a.startsWith("-") && a !== "-") {
      if (a === "-h") flags.set("help", true);
      else if (a === "-v") flags.set("version", true);
      else throw new UsageError(`unknown flag ${a}\nrun 'metonym --help'`);
    } else {
      paths.push(a);
    }
  }

  const reporter = flags.get("reporter");
  if (reporter !== undefined && reporter !== "pretty" && reporter !== "json") {
    throw new UsageError(
      `invalid --reporter=${String(reporter)} (allowed: pretty, json)`,
    );
  }
  const analysis = flags.get("analysis");
  if (
    analysis !== undefined &&
    analysis !== "auto" &&
    analysis !== "shallow" &&
    analysis !== "deep"
  ) {
    throw new UsageError(
      `invalid --analysis=${String(analysis)} (allowed: auto, shallow, deep)`,
    );
  }
  const timeout = flags.get("timeout");
  if (timeout !== undefined && !isPositiveInteger(timeout)) {
    throw new UsageError(
      `invalid --timeout=${String(timeout)} (must be a positive integer)`,
    );
  }
  const bail = flags.get("bail");
  if (bail !== undefined && bail !== true && !isPositiveInteger(bail)) {
    throw new UsageError(
      `invalid --bail=${String(bail)} (must be a positive integer)`,
    );
  }

  return { command, paths, flags };
}

const HELP = `metonym v${TOOL_VERSION} — executable documentation for Bun

Usage:
  metonym check [paths…]              verify documentation examples
  metonym test  [paths…]              alias of check
  metonym extract [--format=json]     emit the Documentation IR
  metonym extract --format=tests      write generated bun:test files
  metonym build --format=<fmt>        render docs (markdown|html|json|jsonl)
  metonym graph --format=<fmt>        emit the doc/code graph (json|mermaid|dot)
  metonym coverage [--check]          coverage report (--check: enforce config gates)
  metonym impact [files…]             trace which examples a change affects
                                      (files from args or git; --format=text|json|mermaid|dot)

Flags:
  --format=<fmt>                      extract/build output format
  --out-dir=<dir>                     output directory
  --filter=<substring>                only run examples whose title matches
  --only=<id|file:line>               run only these examples (repeatable)
  --list                              print selected examples, don't run them
  --failed                            run only examples that failed last run
  --reporter=pretty|json              check output format (default pretty)
  --root=<dir>                        project root (default cwd)
  --analysis=auto|shallow|deep        symbol analysis depth (deep needs typescript)
  --full                              bypass caches, run everything
  --changed[=<ref>]                   check only examples affected by git changes
  --since=<ref>                       impact: diff base ref, default merge-base with origin
  --timeout=<ms>                      per-test timeout (check/build --run)
  --bail[=<n>]                        stop after n failures, default 1 (check/build --run)
  --watch                             re-run on file changes (check only)
  --run                               build: execute examples to annotate statuses
  --no-config                         ignore metonym.config.ts (package.json#metonym still applies)
  --help, --version
`;

function strFlag(
  flags: Map<string, string | true>,
  name: string,
): string | undefined {
  const v = flags.get(name);
  return typeof v === "string" ? v : undefined;
}

function onlyFlag(flags: Map<string, string | true>): string[] | undefined {
  const v = flags.get("only");
  return typeof v === "string" ? v.split(",") : undefined;
}

/** Joins `dir` onto `root` unless `dir` is already absolute (e.g. `--out-dir=/tmp/mb`). */
function resolveOutDir(root: string, dir: string): string {
  return isAbsolute(dir) ? dir : join(root, dir);
}

async function loadProject(args: Args): Promise<Project> {
  const overrides: Record<string, unknown> = {};
  const outDir = strFlag(args.flags, "out-dir");
  // `build` reads `--out-dir` itself, for rendered output. Letting it also
  // override `project.config.outDir` here would point `build --run`'s
  // generated tests at that same directory, and the test sync's stale-file
  // pruning would delete the docs it just rendered.
  if (outDir && args.command !== "build") overrides.outDir = outDir;
  const analysis = strFlag(args.flags, "analysis");
  if (analysis) overrides.analysis = analysis;
  const project = await scan({
    root: strFlag(args.flags, "root"),
    config: Object.keys(overrides).length
      ? (overrides as Partial<Project["config"]>)
      : undefined,
    noConfigFile: args.flags.has("no-config"),
  });
  if (args.paths.length > 0) {
    const match = (f: string) =>
      args.paths.some(
        (p) => f === p || f.startsWith(`${p.replace(/\/$/, "")}/`),
      );
    project.docFiles = project.docFiles.filter(match);
    project.sourceFiles = project.sourceFiles.filter(match);
    if (project.docFiles.length === 0 && project.sourceFiles.length === 0) {
      throw new UsageError(
        `no documentation or source files matched: ${args.paths.join(", ")}`,
      );
    }
  }
  return project;
}

async function extractFor(
  project: Project,
  full: boolean,
  opts?: { skipAnalysis?: boolean },
): Promise<DocumentationSet> {
  let docs: DocumentationSet;
  let fileKeys: Map<string, string> | undefined;
  if (full) {
    docs = await extract(project);
  } else {
    ({ docs, fileKeys } = await extractCachedWithKeys(project));
  }
  for (const w of docs.warnings ?? [])
    process.stderr.write(`${c.yellow(`warning: ${w}`)}\n`);
  if (opts?.skipAnalysis) return docs;
  const { mode, tsPath } = resolveAnalysisMode(
    project.root,
    project.config.analysis,
  );
  if (mode === "deep") {
    let enriched: { docs: DocumentationSet; diagnostics: string[] };
    if (full) {
      const { enrichWithTypeScript } = await import("../analysis/ts-provider");
      enriched = await enrichWithTypeScript(docs, {
        tsPath,
        sourceFiles: project.sourceFiles,
      });
    } else {
      const { enrichWithTypeScriptCached } = await import(
        "../cache/deep-analysis-cache"
      );
      enriched = await enrichWithTypeScriptCached(docs, {
        tsPath,
        sourceFiles: project.sourceFiles,
        fileKeys,
      });
    }
    for (const d of enriched.diagnostics)
      process.stderr.write(`${c.yellow(`warning: ${d}`)}\n`);
    docs = enriched.docs;
  }
  return docs;
}

/**
 * Whether `check` should run deep analysis. Nothing on the check path
 * reads what it produces (hovers, diagnostics, signatures live on the IR
 * for extract/build/coverage), so under the default "auto" it is pure
 * cold-start cost: loading TypeScript and parsing lib + node_modules
 * typings is ~700ms even on a small repo, and in --watch it reran on
 * every edit. Explicit `analysis: "deep"` keeps it (and its warnings);
 * --changed keeps it because impact tracing is stronger with references.
 */
function checkNeedsAnalysis(project: Project, args: Args): boolean {
  return project.config.analysis === "deep" || args.flags.has("changed");
}

function timeoutFlag(args: Args): number | undefined {
  const v = strFlag(args.flags, "timeout");
  return v === undefined ? undefined : Number(v);
}

function bailFlag(args: Args): boolean | number | undefined {
  const v = args.flags.get("bail");
  if (v === undefined) return undefined;
  return v === true ? true : Number(v);
}

function emptyRunResult(project: Project): RunResult {
  return {
    results: [],
    totals: {
      total: 0,
      passed: 0,
      failed: 0,
      pending: 0,
      skipped: 0,
      durationMs: 0,
    },
    outDir: resolveOutDir(project.root, project.config.outDir),
    exitCode: 0,
  };
}

interface LastRunFile {
  version: 1;
  at: string;
  root: string;
  results: { exampleId: string; status: string; docFile: string }[];
  /** The run's JUnit report was missing, so `skipped` results never actually ran. */
  junitMissing?: boolean;
}

function lastRunPath(root: string): string {
  return `${root}/.metonym/cache/last-run.json`;
}

/** Persists the outcome of a non-`--list` `check`, for a later `--failed`. */
async function writeLastRun(
  project: Project,
  result: RunResult,
): Promise<void> {
  await fs.mkdir(`${project.root}/.metonym/cache`, { recursive: true });
  await writeAtomic(
    lastRunPath(project.root),
    JSON.stringify({
      version: 1,
      at: new Date().toISOString(),
      root: ".",
      results: result.results.map((r) => ({
        exampleId: r.exampleId,
        status: r.status,
        docFile: r.docFile,
      })),
      ...(result.junitMissing ? { junitMissing: true } : {}),
    } satisfies LastRunFile),
  );
}

/** `check --failed`: the ids to re-run, from the last recorded run. */
async function readFailedIds(root: string): Promise<string[]> {
  let lastRun: LastRunFile;
  try {
    lastRun = JSON.parse(await Bun.file(lastRunPath(root)).text());
  } catch {
    throw new UsageError("no previous run recorded; run 'metonym check' first");
  }
  return lastRun.results
    .filter(
      (r) =>
        r.status === "failed" ||
        (lastRun.junitMissing && r.status === "skipped"),
    )
    .map((r) => r.exampleId);
}

/** `check --list`: print the selected examples to stdout, without generating or running anything. */
function listExamples(docs: DocumentationSet, json: boolean): void {
  if (json) {
    process.stdout.write(
      `${JSON.stringify({
        tool: { name: TOOL_NAME, version: TOOL_VERSION },
        examples: docs.examples.map((e) => ({
          id: e.id,
          kind: e.kind,
          language: e.language,
          docFile: e.source.file,
          line: e.source.start.line,
          title: e.title,
          ...(e.group ? { group: e.group } : {}),
        })),
      })}\n`,
    );
    return;
  }
  for (const e of docs.examples) {
    process.stdout.write(
      `${e.id}\t${e.kind}\t${e.source.file}:${e.source.start.line}\t${e.title}\n`,
    );
  }
}

async function checkOnce(
  project: Project,
  args: Args,
  signal?: AbortSignal,
): Promise<RunResult> {
  const full = args.flags.has("full");
  let failedOnly: string[] | undefined;
  if (args.flags.has("failed")) {
    failedOnly = await readFailedIds(project.root);
    if (failedOnly.length === 0) {
      process.stderr.write("nothing failed in the last run\n");
      return emptyRunResult(project);
    }
  }
  let docs = await extractFor(project, full, {
    skipAnalysis: !checkNeedsAnalysis(project, args),
  });
  selectExamples(docs, {
    filter: strFlag(args.flags, "filter"),
    only: failedOnly ?? onlyFlag(args.flags),
  });
  if (args.flags.has("changed") && !full) {
    const { selectAffected } = await import("../graph/select");
    const selection = await selectAffected(docs, {
      since: strFlag(args.flags, "changed"),
    });
    if (selection.note) process.stderr.write(`${selection.note}\n`);
    if (selection.mode === "affected") {
      for (const [id, reasons] of selection.reasons) {
        const ex = docs.examples.find((e) => e.id === id);
        process.stderr.write(`  ${ex?.title ?? id} ← ${reasons.join("; ")}\n`);
      }
      docs = selection.docs;
    }
  }
  if (args.flags.has("list")) {
    listExamples(docs, args.flags.get("reporter") === "json");
    return emptyRunResult(project);
  }
  const emit = {
    jsxImportSource: project.config.jsxImportSource,
    inject: project.config.inject,
  };
  for (const gt of generate(docs, emit)) {
    for (const diag of gt.diagnostics ?? [])
      process.stderr.write(`${c.yellow(`warning: ${diag}`)}\n`);
  }
  const result = await runCached(docs, {
    outDir: resolveOutDir(project.root, project.config.outDir),
    full,
    emit,
    timeoutMs: timeoutFlag(args),
    bail: bailFlag(args),
    signal,
  });
  if (args.flags.get("reporter") === "json") {
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } else {
    await reportPretty(result, project.root);
  }
  await writeLastRun(project, result);
  return result;
}

async function main(): Promise<number> {
  try {
    return await run();
  } catch (err) {
    if (err instanceof UsageError) {
      process.stderr.write(`${c.red(`error: ${err.message}`)}\n`);
      return 2;
    }
    throw err;
  }
}

async function run(): Promise<number> {
  const args = parseArgs(process.argv.slice(2));
  if (args.flags.has("help") || args.command === "help") {
    process.stdout.write(HELP);
    return 0;
  }
  if (args.flags.has("version") || args.command === "version") {
    process.stdout.write(`metonym ${TOOL_VERSION}\n`);
    return 0;
  }

  switch (args.command) {
    case "check":
    case "test": {
      const controller = new AbortController();
      let interrupted = false;
      const onInterrupt = () => {
        if (interrupted) return;
        interrupted = true;
        controller.abort();
        process.stderr.write("\ninterrupted\n");
      };
      process.on("SIGINT", onInterrupt);
      process.on("SIGTERM", onInterrupt);
      try {
        let project = await loadProject(args);
        if (!args.flags.has("watch")) {
          const result = await checkOnce(project, args, controller.signal);
          if (result.exitCode === 130) return 130;
          // A nonzero bun-test exit with zero matched failures means the run
          // itself broke (e.g. a generated file failed to load) — never exit 0.
          if (result.totals.failed > 0) return 1;
          if (result.exitCode !== 0) {
            if (result.stderr) {
              for (const line of result.stderr.split("\n")) {
                process.stderr.write(`${c.dim(`  ${line}`)}\n`);
              }
            }
            process.stderr.write(
              `${c.red("error: test run did not complete cleanly (see skipped examples above)")}\n`,
            );
            return 1;
          }
          return 0;
        }

        process.stderr.write("\nwatching for changes… (ctrl-c to exit)\n");
        const { watchProject } = await import("../watch/watch");
        let watchExitCode = 0;
        let done: (() => void) | undefined;
        const watchDone = new Promise<void>((resolve) => {
          done = resolve;
        });
        let watcher: { stop(): void } | undefined;
        try {
          watcher = watchProject({
            root: project.root,
            config: project.config,
            onChange: async (files) => {
              process.stderr.write(`\nchanged: ${files.join(", ")}\n`);
              try {
                project = await loadProject(args); // re-scan: files may appear/vanish
                const result = await checkOnce(
                  project,
                  args,
                  controller.signal,
                );
                if (result.exitCode === 130) {
                  watchExitCode = 130;
                  watcher?.stop();
                  done?.();
                  return;
                }
              } catch (err) {
                const message =
                  err instanceof Error ? err.message : String(err);
                process.stderr.write(`${c.red(`error: ${message}`)}\n`);
              }
              process.stderr.write(
                "\nwatching for changes… (ctrl-c to exit)\n",
              );
            },
          });
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          process.stderr.write(`${c.red(`error: ${message}`)}\n`);
          return 1;
        }
        controller.signal.addEventListener("abort", () => {
          watcher?.stop();
          watchExitCode = 130;
          done?.();
        });
        await watchDone; // run until interrupted
        return watchExitCode;
      } finally {
        process.off("SIGINT", onInterrupt);
        process.off("SIGTERM", onInterrupt);
      }
    }

    case "extract": {
      const project = await loadProject(args);
      const docs = await extractFor(project, args.flags.has("full"));
      const format = args.flags.get("format") ?? "json";
      if (format === "json") {
        process.stdout.write(
          `${JSON.stringify({ ...docs, root: "." }, null, 2)}\n`,
        );
        return 0;
      }
      if (format === "jsonl") {
        for (const ex of docs.examples)
          process.stdout.write(`${JSON.stringify(ex)}\n`);
        return 0;
      }
      if (format === "tests") {
        const outDir = resolveOutDir(project.root, project.config.outDir);
        for (const gt of generate(docs, {
          jsxImportSource: project.config.jsxImportSource,
          inject: project.config.inject,
        })) {
          await Bun.write(`${outDir}/${gt.path}`, gt.code);
          await Bun.write(
            `${outDir}/${gt.path}.map.json`,
            `${JSON.stringify(gt.map, null, 2)}\n`,
          );
          process.stdout.write(`${project.config.outDir}/${gt.path}\n`);
        }
        return 0;
      }
      process.stderr.write(`${c.red(`unknown --format=${String(format)}`)}\n`);
      return 2;
    }

    case "build": {
      const project = await loadProject(args);
      const docs = await extractFor(project, args.flags.has("full"));
      const format = String(args.flags.get("format") ?? "markdown");
      const { renderers } = await import("../render/index");
      const renderer = renderers[format];
      if (!renderer) {
        process.stderr.write(
          `${c.red(`unknown --format=${format} (available: ${Object.keys(renderers).sort().join(", ")})`)}\n`,
        );
        return 2;
      }
      let results: RunResult | undefined;
      if (args.flags.has("run")) {
        results = await runCached(docs, {
          outDir: resolveOutDir(project.root, project.config.outDir),
          full: args.flags.has("full"),
          timeoutMs: timeoutFlag(args),
        });
      }
      const outDirFlag = strFlag(args.flags, "out-dir") ?? ".metonym/build";
      const outDir = resolveOutDir(project.root, outDirFlag);
      const rendered = await renderer.render(docs, { results });
      for (const f of rendered.files) {
        await Bun.write(`${outDir}/${f.path}`, f.contents);
        process.stdout.write(`${outDirFlag}/${f.path}\n`);
      }
      return 0;
    }

    case "graph": {
      const format = String(args.flags.get("format") ?? "json");
      if (format !== "json" && format !== "mermaid" && format !== "dot") {
        process.stderr.write(
          `${c.red(`unknown --format=${format} (available: dot, json, mermaid)`)}\n`,
        );
        return 2;
      }
      const project = await loadProject(args);
      const docs = await extractFor(project, args.flags.has("full"));
      const { toDot, toGraphJSON, toMermaid } = await import("../graph/emit");
      const emit =
        format === "json"
          ? toGraphJSON
          : format === "mermaid"
            ? toMermaid
            : toDot;
      if (!docs.relations.some((r) => r.kind === "references")) {
        const { ensureReferences } = await import("../graph/references");
        docs.relations = [...docs.relations, ...ensureReferences(docs)];
      }
      process.stdout.write(emit(docs));
      return 0;
    }

    case "coverage": {
      const project = await loadProject(args);
      const docs = await extractFor(project, args.flags.has("full"));
      const { checkCoverage, coverage } = await import("../graph/queries");
      const report = coverage(docs);

      let gateResult: { pass: boolean; failures: string[] } | undefined;
      if (args.flags.has("check")) {
        const gates = project.config.coverage ?? {};
        const gate = checkCoverage(docs, gates, report);
        gateResult = { pass: gate.pass, failures: gate.failures };
      }

      if (args.flags.get("reporter") === "json") {
        const json = gateResult ? { ...report, gates: gateResult } : report;
        process.stdout.write(`${JSON.stringify(json, null, 2)}\n`);
      } else {
        const s = report.symbols;
        const at = (sym: {
          file: string;
          name: string;
          loc?: { start: { line: number } };
        }) =>
          sym.loc
            ? `${sym.file}:${sym.loc.start.line} › ${sym.name}`
            : `${sym.file} › ${sym.name}`;
        const out: string[] = [
          `symbols     ${s.total} total · ${s.documented} documented · ${s.withExamples} with examples · ${report.exercised.length} exercised by examples` +
            (report.reexports
              ? ` · ${report.reexports} re-exports (excluded)`
              : ""),
          `documents   ${report.documents.total} total · ${report.documents.withExamples} with examples`,
        ];
        if (report.undocumented.length) {
          out.push("", "undocumented exports:");
          for (const sym of report.undocumented) out.push(`  ${at(sym)}`);
        }
        if (report.documentedWithoutExamples.length) {
          out.push("", "documented but no executable examples:");
          for (const sym of report.documentedWithoutExamples)
            out.push(`  ${at(sym)}`);
        }
        if (report.examplesWithTypeErrors.length) {
          out.push("", "examples with type errors:");
          for (const ex of report.examplesWithTypeErrors)
            out.push(`  ${ex.docFile} › ${ex.title} (${ex.errorCount})`);
        } else if (
          resolveAnalysisMode(project.root, project.config.analysis).mode !==
          "deep"
        ) {
          out.push(
            "",
            "examples with type errors:",
            "  (type errors: deep analysis off)",
          );
        }
        process.stdout.write(`${out.join("\n")}\n`);
      }

      if (gateResult) {
        if (!gateResult.pass) {
          process.stderr.write(`${c.red("coverage gate failed:")}\n`);
          for (const f of gateResult.failures)
            process.stderr.write(`${c.red(`  ${f}`)}\n`);
          return 1;
        }
        process.stderr.write(`${c.green("coverage gates passed")}\n`);
      }
      return 0;
    }

    case "impact": {
      const format = String(args.flags.get("format") ?? "text");
      if (
        format !== "text" &&
        format !== "json" &&
        format !== "mermaid" &&
        format !== "dot"
      ) {
        process.stderr.write(
          `${c.red(`unknown --format=${format} (available: dot, json, mermaid, text)`)}\n`,
        );
        return 2;
      }
      // Path args are the CHANGED files here, not a project filter.
      const project = await loadProject({ ...args, paths: [] });
      const docs = await extractFor(project, args.flags.has("full"));
      let changed: string[];
      let topLevel: string | undefined;
      if (args.paths.length > 0) {
        const { gitTopLevel } = await import("../graph/git");
        const { isWithin, toProjectRelative } = await import("../graph/paths");
        const { resolve: pathResolve } = await import("node:path");
        topLevel = gitTopLevel(project.root);
        changed = [];
        for (const p of args.paths) {
          const rel = toProjectRelative(project.root, p);
          if (rel.startsWith("../")) {
            const abs = pathResolve(project.root, rel);
            if (topLevel === undefined || !isWithin(topLevel, abs)) {
              process.stderr.write(
                `warning: ${p} is outside the project root; ignored\n`,
              );
              continue;
            }
          }
          changed.push(rel);
        }
      } else {
        const { changedFiles } = await import("../graph/git");
        const git = changedFiles(project.root, strFlag(args.flags, "since"));
        if (!git.available) {
          process.stderr.write(
            `${c.red("error: not a git repository — pass changed files as arguments")}\n`,
          );
          return 2;
        }
        changed = git.changedFiles;
        topLevel = git.topLevel;
      }
      if (changed.length === 0) {
        process.stderr.write("no changes detected\n");
        return 0;
      }
      const { computeImpact, impactGraph, renderImpactTree } = await import(
        "../graph/impact"
      );
      const impact = await computeImpact(docs, changed, { topLevel });
      if (format === "text") {
        process.stdout.write(renderImpactTree(impact));
      } else if (format === "json") {
        process.stdout.write(`${JSON.stringify(impact, null, 2)}\n`);
      } else {
        const { serializeDot, serializeMermaid } = await import(
          "../graph/emit"
        );
        const g = impactGraph(docs, impact);
        process.stdout.write(
          format === "mermaid" ? serializeMermaid(g) : serializeDot(g),
        );
      }
      return 0;
    }

    default:
      process.stderr.write(
        `${c.red(`unknown command: ${args.command}`)}\n\n${HELP}`,
      );
      return 2;
  }
}

// A closed pipe (e.g. `metonym graph | head`) is normal Unix behavior, not a crash.
process.stdout.on("error", (err: NodeJS.ErrnoException) => {
  if (err.code === "EPIPE") process.exit(0);
  throw err;
});

// Set exitCode rather than calling process.exit(): exit() doesn't wait for
// piped stdout to drain and truncates large output at the 128KiB pipe buffer.
process.exitCode = await main();
