#!/usr/bin/env bun

/**
 * metonym CLI.
 *   metonym check [paths…]   extract + run + report (exit 1 on failures)
 *   metonym test  [paths…]   alias of check
 *   metonym extract          emit IR or generated tests (--format=json|jsonl|tests)
 *   metonym build            render docs (--format=markdown|html|json|jsonl)
 */

import * as fs from "node:fs/promises";
import { join, resolve } from "node:path";
import { resolveAnalysisMode } from "../analysis/provider";
import { writeAtomic } from "../cache/fs";
import { runCached } from "../cache/result-cache";
import { generate } from "../emit/generate";
import { type Project, type RunResult, TOOL_VERSION } from "../ir/types";
import { discoverWorkspaces } from "../scan/workspaces";
import { c } from "./colors";
import {
  type CheckCommandOptions,
  type CommandOptions,
  checkCommand,
  coverageCommand,
  extractCommand,
  extractFor,
  impactCommand,
  type ListedExample,
  resolveOutDir,
  resolveProject,
  selectCommand,
} from "./commands";
import { stampJson } from "./json";
import { reportPretty } from "./reporter";
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
  "no-color",
  "workspaces",
  "allow-run",
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
  if (
    reporter !== undefined &&
    reporter !== "pretty" &&
    reporter !== "json" &&
    reporter !== "github" &&
    reporter !== "junit"
  ) {
    throw new UsageError(
      `invalid --reporter=${String(reporter)} (allowed: pretty, json, github, junit)`,
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
  metonym mcp [--allow-run]           run an MCP server over stdio for agents
                                      (--allow-run: enable the metonym_check tool)

Flags:
  --format=<fmt>                      extract/build output format
  --out-dir=<dir>                     output directory
  --filter=<substring>                only run examples whose title matches
  --only=<id|file:line>               run only these examples (repeatable)
  --list                              print selected examples, don't run them
  --failed                            run only examples that failed last run
  --reporter=pretty|json|github|junit  check output format (default pretty;
                                      github auto-selected under GITHUB_ACTIONS)
  --root=<dir>                        project root (default cwd)
  --analysis=auto|shallow|deep        symbol analysis depth (deep needs typescript)
  --full                              bypass caches, run everything
  --changed[=<ref>]                   check only examples affected by git changes
  --since=<ref>                       impact: diff base ref, default merge-base with origin
  --timeout=<ms>                      per-test timeout (check/build --run)
  --bail[=<n>]                        stop after n failures, default 1 (check/build --run)
  --watch                             re-run on file changes (check only)
  --workspaces                        run check in every package.json#workspaces package
  --run                               build: execute examples to annotate statuses
  --no-config                         ignore metonym.config.ts (package.json#metonym still applies)
  --no-color                          disable colored output (also respects NO_COLOR/FORCE_COLOR)
  --allow-run                         mcp: register the metonym_check tool (executes documentation code)
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

/** Used by `build`/`graph`, which keep operating on a pre-loaded `Project`. */
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
  return resolveProject({
    root: strFlag(args.flags, "root"),
    paths: args.paths,
    overrides: Object.keys(overrides).length
      ? (overrides as Partial<Project["config"]>)
      : undefined,
    noConfigFile: args.flags.has("no-config"),
  });
}

/** Shared option fields for the `commands.ts` verbs, read from parsed CLI flags. */
function commonOptionsFrom(args: Args): CommandOptions {
  return {
    root: strFlag(args.flags, "root"),
    paths: args.paths,
    outDir: strFlag(args.flags, "out-dir"),
    filter: strFlag(args.flags, "filter"),
    changed: args.flags.get("changed") as string | boolean | undefined,
    full: args.flags.has("full"),
    analysis: strFlag(args.flags, "analysis") as CommandOptions["analysis"],
    noConfig: args.flags.has("no-config"),
  };
}

function checkOptionsFrom(
  args: Args,
  only: string[] | undefined,
  signal: AbortSignal,
): CheckCommandOptions {
  return {
    ...commonOptionsFrom(args),
    only,
    timeoutMs: timeoutFlag(args),
    bail: bailFlag(args),
    signal,
  };
}

/** Root a `--root=<dir>` flag resolves to, without a full project scan (for `--failed`). */
function resolveRoot(args: Args): string {
  const root = strFlag(args.flags, "root");
  return root ? resolve(root) : process.cwd();
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

/**
 * One `check` pass: `--list` prints selected examples and returns; otherwise
 * runs them, prints via the chosen reporter, and records the run for a later
 * `--failed`. Called once for a plain `check`, and once per file change
 * under `--watch`, so `--list`/`--failed` are re-evaluated fresh each time.
 */
async function runCheckOnce(args: Args, signal: AbortSignal): Promise<number> {
  let only = onlyFlag(args.flags);
  if (args.flags.has("failed")) {
    only = await readFailedIds(resolveRoot(args));
    if (only.length === 0) {
      process.stderr.write("nothing failed in the last run\n");
      return 0;
    }
  }

  if (args.flags.has("list")) {
    const { examples } = await selectCommand({
      ...commonOptionsFrom(args),
      only,
    });
    if (args.flags.get("reporter") === "json") {
      process.stdout.write(
        `${JSON.stringify(stampJson("list", { examples }))}\n`,
      );
    } else {
      for (const e of examples) {
        process.stdout.write(
          `${e.id}\t${e.kind}\t${e.docFile}:${e.line}\t${e.title}\n`,
        );
      }
    }
    return 0;
  }

  const { project, result } = await checkCommand(
    checkOptionsFrom(args, only, signal),
  );
  // Explicit --reporter=pretty opts out of the GitHub Actions auto-select.
  const reporter =
    strFlag(args.flags, "reporter") ??
    (process.env.GITHUB_ACTIONS === "true" ? "github" : "pretty");
  if (reporter === "json") {
    process.stdout.write(
      `${JSON.stringify(stampJson("run", result), null, 2)}\n`,
    );
  } else if (reporter === "github") {
    const { reportGithub } = await import("./reporters/github");
    reportGithub(result);
    await reportPretty(result, project.root);
  } else if (reporter === "junit") {
    const { reportJunit } = await import("./reporters/junit");
    process.stdout.write(reportJunit(result));
  } else {
    await reportPretty(result, project.root);
  }
  await writeLastRun(project, result);

  if (result.exitCode === 130) return 130;
  // A nonzero bun-test exit with zero matched failures means the run itself
  // broke (e.g. a generated file failed to load) — never exit 0.
  if (result.totals.failed > 0) return 1;
  if (result.exitCode !== 0) {
    printBrokenRun(result);
    return 1;
  }
  return 0;
}

/** Prints a broken (non-cleanly-completed) run's stderr and error line. */
function printBrokenRun(result: RunResult): void {
  if (result.stderr) {
    for (const line of result.stderr.split("\n")) {
      process.stderr.write(`${c.dim(`  ${line}`)}\n`);
    }
  }
  process.stderr.write(
    `${c.red("error: test run did not complete cleanly (see skipped examples above)")}\n`,
  );
}

/**
 * Options for one workspace package: root scoped to the package directory,
 * plus the subset of root flags `--workspaces` forwards. Positional paths
 * from the root invocation only apply to a package when they start with
 * that package's directory (stripped to package-relative); otherwise
 * they're ignored for that package, i.e. it runs unfiltered. `--full`,
 * `--out-dir`, and `--reporter` are deliberately not forwarded: caching and
 * output location are per-package concerns, and the reporter is applied
 * once at the `--workspaces` level.
 */
function packageCommandOptions(
  rootProject: Project,
  pkg: string,
  args: Args,
): CommandOptions {
  const prefix = `${pkg.replace(/\/$/, "")}/`;
  const paths = args.paths
    .filter((p) => p === pkg || p.startsWith(prefix))
    .map((p) => (p === pkg ? "" : p.slice(prefix.length)))
    .filter((p) => p.length > 0);
  return {
    root: join(rootProject.root, pkg),
    paths,
    filter: strFlag(args.flags, "filter"),
    only: onlyFlag(args.flags),
    changed: args.flags.get("changed") as string | boolean | undefined,
    analysis: strFlag(args.flags, "analysis") as CommandOptions["analysis"],
    noConfig: args.flags.has("no-config"),
    strict: false,
  };
}

function mergeTotals(totalsList: RunResult["totals"][]): RunResult["totals"] {
  const totals = {
    total: 0,
    passed: 0,
    failed: 0,
    pending: 0,
    skipped: 0,
    durationMs: 0,
    cached: 0,
  };
  for (const t of totalsList) {
    totals.total += t.total;
    totals.passed += t.passed;
    totals.failed += t.failed;
    totals.pending += t.pending;
    totals.skipped += t.skipped;
    totals.durationMs += t.durationMs;
    totals.cached += t.cached ?? 0;
  }
  return totals;
}

/** `check --workspaces --list`: per-package listing, never generates or runs anything. */
async function listWorkspaces(
  rootProject: Project,
  pkgs: string[],
  args: Args,
): Promise<number> {
  const json = strFlag(args.flags, "reporter") === "json";
  const packages: { package: string; examples: ListedExample[] }[] = [];
  for (const pkg of pkgs) {
    const { examples } = await selectCommand(
      packageCommandOptions(rootProject, pkg, args),
    );
    if (json) {
      packages.push({ package: pkg, examples });
    } else {
      for (const e of examples) {
        process.stdout.write(
          `${e.id}\t${e.kind}\t${pkg}/${e.docFile}:${e.line}\t${e.title}\n`,
        );
      }
    }
  }
  if (json) {
    process.stdout.write(
      `${JSON.stringify(stampJson("list", { packages }))}\n`,
    );
  }
  return 0;
}

/** `check --workspaces`: runs `check` in every package.json#workspaces package. */
async function checkWorkspaces(
  rootProject: Project,
  args: Args,
  signal: AbortSignal,
): Promise<number> {
  const pkgs = await discoverWorkspaces(rootProject.root);
  if (pkgs.length === 0) {
    throw new UsageError(
      "--workspaces: package.json#workspaces matched no packages",
    );
  }

  if (args.flags.has("list")) {
    return listWorkspaces(rootProject, pkgs, args);
  }

  const reporter =
    strFlag(args.flags, "reporter") ??
    (process.env.GITHUB_ACTIONS === "true" ? "github" : "pretty");

  const entries: { package: string; result: RunResult }[] = [];
  let failedOrBroken = false;

  for (const pkg of pkgs) {
    const { project, result } = await checkCommand({
      ...packageCommandOptions(rootProject, pkg, args),
      timeoutMs: timeoutFlag(args),
      bail: bailFlag(args),
      signal,
    });
    await writeLastRun(project, result);
    entries.push({ package: pkg, result });

    if (result.exitCode === 130) return 130;

    if (result.totals.total === 0) {
      process.stderr.write(`${c.bold(pkg)}: no examples\n`);
    } else if (reporter === "pretty" || reporter === "github") {
      // `github` also prints the pretty report to stderr, same as `check`.
      process.stderr.write(`${c.bold(pkg)}\n`);
      await reportPretty(result, project.root);
      if (result.exitCode !== 0 && result.totals.failed === 0) {
        printBrokenRun(result);
      }
      if (reporter === "github") {
        const { reportGithub } = await import("./reporters/github");
        reportGithub(result);
      }
    } else if (reporter === "junit") {
      const { reportJunit } = await import("./reporters/junit");
      process.stdout.write(reportJunit(result));
    }

    if (result.totals.failed > 0 || result.exitCode !== 0) {
      failedOrBroken = true;
    }
  }

  if (reporter === "json") {
    process.stdout.write(
      `${JSON.stringify(
        stampJson("run", {
          packages: entries.map((e) => ({
            package: e.package,
            ...e.result,
          })),
          totals: mergeTotals(entries.map((e) => e.result.totals)),
        }),
        null,
        2,
      )}\n`,
    );
  }

  return failedOrBroken ? 1 : 0;
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
        if (args.flags.has("workspaces")) {
          if (args.flags.has("watch")) {
            throw new UsageError("--watch is not supported with --workspaces");
          }
          const rootProject = await loadProject(args);
          return await checkWorkspaces(rootProject, args, controller.signal);
        }
        if (!args.flags.has("watch")) {
          return await runCheckOnce(args, controller.signal);
        }

        const project = await loadProject(args);
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
                const exitCode = await runCheckOnce(args, controller.signal);
                if (exitCode === 130) {
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
      const { project, docs } = await extractCommand(commonOptionsFrom(args));
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
      const {
        project,
        report,
        gates: gateResult,
      } = await coverageCommand({
        ...commonOptionsFrom(args),
        check: args.flags.has("check"),
      });

      if (args.flags.get("reporter") === "json") {
        const json = gateResult ? { ...report, gates: gateResult } : report;
        process.stdout.write(
          `${JSON.stringify(stampJson("coverage", json), null, 2)}\n`,
        );
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
      const out = await impactCommand({
        ...commonOptionsFrom(args),
        since: strFlag(args.flags, "since"),
        changedPaths: args.paths.length > 0 ? args.paths : undefined,
      });
      if (!out.impact) return 0;
      if (format === "text") {
        const { renderImpactTree } = await import("../graph/impact");
        process.stdout.write(renderImpactTree(out.impact));
      } else if (format === "json") {
        process.stdout.write(
          `${JSON.stringify(stampJson("impact", out.impact), null, 2)}\n`,
        );
      } else {
        const { impactGraph } = await import("../graph/impact");
        const { serializeDot, serializeMermaid } = await import(
          "../graph/emit"
        );
        const g = impactGraph(out.docs, out.impact);
        process.stdout.write(
          format === "mermaid" ? serializeMermaid(g) : serializeDot(g),
        );
      }
      return 0;
    }

    case "mcp": {
      const { runMcpServer } = await import("../mcp/server");
      await runMcpServer({ allowRun: args.flags.has("allow-run") });
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
