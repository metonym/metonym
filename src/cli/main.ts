#!/usr/bin/env bun

/**
 * metonym CLI.
 *   metonym check [paths…]   extract + run + report (exit 1 on failures)
 *   metonym test  [paths…]   alias of check
 *   metonym extract          emit IR or generated tests (--format=json|jsonl|tests)
 *   metonym build            render docs (--format=markdown|html|json|jsonl)
 */

import { resolveAnalysisMode } from "../analysis/provider";
import { extractCachedWithKeys } from "../cache/extract-cache";
import { runCached } from "../cache/result-cache";
import { generate } from "../emit/generate";
import { extract } from "../extract";
import {
  type DocumentationSet,
  type Project,
  type RunResult,
  TOOL_VERSION,
} from "../ir/types";
import { scan } from "../scan/scan";
import { c } from "./colors";
import { reportPretty } from "./reporter";

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

function parseArgs(argv: string[]): Args {
  // A leading flag (e.g. `metonym --help`) means no command was given —
  // don't swallow it as the command positional.
  const hasCommand = argv.length > 0 && !argv[0].startsWith("--");
  const command = hasCommand ? argv[0] : "check";
  const rest = hasCommand ? argv.slice(1) : argv;
  const paths: string[] = [];
  const flags = new Map<string, string | true>();
  for (const a of rest) {
    if (a.startsWith("--")) {
      const eq = a.indexOf("=");
      if (eq === -1) flags.set(a.slice(2), true);
      else flags.set(a.slice(2, eq), a.slice(eq + 1));
    } else {
      paths.push(a);
    }
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
  --reporter=pretty|json              check output format (default pretty)
  --root=<dir>                        project root (default cwd)
  --analysis=auto|shallow|deep        symbol analysis depth (deep needs typescript)
  --full                              bypass caches, run everything
  --changed[=<ref>]                   check only examples affected by git changes
  --watch                             re-run on file changes (check only)
  --run                               build: execute examples to annotate statuses
  --help, --version
`;

function strFlag(
  flags: Map<string, string | true>,
  name: string,
): string | undefined {
  const v = flags.get(name);
  return typeof v === "string" ? v : undefined;
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
  });
  if (args.paths.length > 0) {
    const match = (f: string) =>
      args.paths.some(
        (p) => f === p || f.startsWith(`${p.replace(/\/$/, "")}/`),
      );
    project.docFiles = project.docFiles.filter(match);
    project.sourceFiles = project.sourceFiles.filter(match);
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

function applyFilter(docs: DocumentationSet, filter: string | undefined): void {
  if (!filter) return;
  const keep = new Set(
    docs.examples.filter((e) => e.title.includes(filter)).map((e) => e.id),
  );
  docs.examples = docs.examples.filter((e) => keep.has(e.id));
  for (const d of docs.documents)
    d.exampleIds = d.exampleIds.filter((id) => keep.has(id));
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

async function checkOnce(project: Project, args: Args): Promise<RunResult> {
  const full = args.flags.has("full");
  let docs = await extractFor(project, full, {
    skipAnalysis: !checkNeedsAnalysis(project, args),
  });
  applyFilter(docs, strFlag(args.flags, "filter"));
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
  const emit = { jsxImportSource: project.config.jsxImportSource };
  for (const gt of generate(docs, emit)) {
    for (const diag of gt.diagnostics ?? [])
      process.stderr.write(`${c.yellow(`warning: ${diag}`)}\n`);
  }
  const result = await runCached(docs, {
    outDir: `${project.root}/${project.config.outDir}`,
    full,
    emit,
  });
  if (args.flags.get("reporter") === "json") {
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } else {
    await reportPretty(result, project.root);
  }
  return result;
}

async function main(): Promise<number> {
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
      let project = await loadProject(args);
      const result = await checkOnce(project, args);
      if (!args.flags.has("watch")) {
        // A nonzero bun-test exit with zero matched failures means the run
        // itself broke (e.g. a generated file failed to load) — never exit 0.
        if (result.totals.failed > 0) return 1;
        if (result.exitCode !== 0) {
          process.stderr.write(
            `${c.red("error: test run did not complete cleanly (see skipped examples above)")}\n`,
          );
          return 1;
        }
        return 0;
      }

      process.stderr.write("\nwatching for changes… (ctrl-c to exit)\n");
      const { watchProject } = await import("../watch/watch");
      watchProject({
        root: project.root,
        config: project.config,
        onChange: async (files) => {
          process.stderr.write(`\nchanged: ${files.join(", ")}\n`);
          project = await loadProject(args); // re-scan: files may appear/vanish
          await checkOnce(project, args);
          process.stderr.write("\nwatching for changes… (ctrl-c to exit)\n");
        },
      });
      await new Promise(() => {}); // run until interrupted
      return 0;
    }

    case "extract": {
      const project = await loadProject(args);
      const docs = await extractFor(project, args.flags.has("full"));
      const format = args.flags.get("format") ?? "json";
      if (format === "json") {
        process.stdout.write(`${JSON.stringify(docs, null, 2)}\n`);
        return 0;
      }
      if (format === "jsonl") {
        for (const ex of docs.examples)
          process.stdout.write(`${JSON.stringify(ex)}\n`);
        return 0;
      }
      if (format === "tests") {
        const outDir = `${project.root}/${project.config.outDir}`;
        for (const gt of generate(docs, {
          jsxImportSource: project.config.jsxImportSource,
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
          outDir: `${project.root}/${project.config.outDir}`,
          full: args.flags.has("full"),
        });
      }
      const outDir = strFlag(args.flags, "out-dir") ?? ".metonym/build";
      const rendered = await renderer.render(docs, { results });
      for (const f of rendered.files) {
        await Bun.write(`${project.root}/${outDir}/${f.path}`, f.contents);
        process.stdout.write(`${outDir}/${f.path}\n`);
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
        const { exampleReferences } = await import("../graph/references");
        docs.relations = [...docs.relations, ...exampleReferences(docs)];
      }
      process.stdout.write(emit(docs));
      return 0;
    }

    case "coverage": {
      const project = await loadProject(args);
      const docs = await extractFor(project, args.flags.has("full"));
      const { checkCoverage, coverage } = await import("../graph/queries");
      const report = coverage(docs);
      const deepRefs = new Set(
        docs.relations.filter((r) => r.kind === "references").map((r) => r.to),
      );
      let exercised = deepRefs;
      if (deepRefs.size === 0) {
        const { exercisedSymbols } = await import("../graph/references");
        exercised = exercisedSymbols(docs);
      }
      if (args.flags.get("reporter") === "json") {
        process.stdout.write(
          `${JSON.stringify({ ...report, exercised: [...exercised].sort() }, null, 2)}\n`,
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
          `symbols     ${s.total} total · ${s.documented} documented · ${s.withExamples} with examples · ${exercised.size} exercised by examples` +
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
        }
        process.stdout.write(`${out.join("\n")}\n`);
      }
      if (args.flags.has("check")) {
        const gates = project.config.coverage ?? {};
        const gate = checkCoverage(docs, gates);
        if (!gate.pass) {
          process.stderr.write(`${c.red("coverage gate failed:")}\n`);
          for (const f of gate.failures)
            process.stderr.write(`${c.red(`  ${f}`)}\n`);
          return 2;
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
      if (args.paths.length > 0) {
        changed = args.paths;
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
      }
      if (changed.length === 0) {
        process.stderr.write("no changes detected\n");
        return 0;
      }
      const { computeImpact, impactGraph, renderImpactTree } = await import(
        "../graph/impact"
      );
      const impact = await computeImpact(docs, changed);
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
