/**
 * Callable verb implementations, shared by the CLI (`main.ts`) and the MCP
 * server. Each command function resolves its own project from a plain
 * options object and returns data — no printing, no `process.exitCode`.
 */

import { isAbsolute, join } from "node:path";
import { resolveAnalysisMode } from "../analysis/provider";
import { extractCachedWithKeys } from "../cache/extract-cache";
import { runCached } from "../cache/result-cache";
import { generate } from "../emit/generate";
import { extract } from "../extract";
import type { Impact } from "../graph/impact";
import type { CoverageReport } from "../graph/queries";
import type {
  DocumentationSet,
  Example,
  ExampleKind,
  Project,
  RunResult,
} from "../ir/types";
import { scan } from "../scan/scan";
import { c } from "./colors";
import { selectExamples } from "./select";
import { UsageError } from "./usage-error";

export interface CommandOptions {
  root?: string;
  paths?: string[];
  outDir?: string;
  filter?: string;
  only?: string[];
  /** Bare `--changed` is `true`; `--changed=<ref>` carries the ref. */
  changed?: string | boolean;
  since?: string;
  full?: boolean;
  analysis?: "auto" | "shallow" | "deep";
  noConfig?: boolean;
  /** When false, an `--only` entry matching nothing yields zero examples instead of throwing. */
  strict?: boolean;
}

function buildOverrides(
  opts: Pick<CommandOptions, "outDir" | "analysis">,
): Partial<Project["config"]> | undefined {
  const overrides: Record<string, unknown> = {};
  if (opts.outDir) overrides.outDir = opts.outDir;
  if (opts.analysis) overrides.analysis = opts.analysis;
  return Object.keys(overrides).length
    ? (overrides as Partial<Project["config"]>)
    : undefined;
}

/** Scans the project and applies the `paths` filter. Shared by every command. */
export async function resolveProject(opts: {
  root?: string;
  paths?: string[];
  overrides?: Partial<Project["config"]>;
  noConfigFile?: boolean;
}): Promise<Project> {
  const project = await scan({
    root: opts.root,
    config: opts.overrides,
    noConfigFile: opts.noConfigFile,
  });
  if (opts.paths && opts.paths.length > 0) {
    const paths = opts.paths;
    const match = (f: string) =>
      paths.some((p) => f === p || f.startsWith(`${p.replace(/\/$/, "")}/`));
    project.docFiles = project.docFiles.filter(match);
    project.sourceFiles = project.sourceFiles.filter(match);
    if (project.docFiles.length === 0 && project.sourceFiles.length === 0) {
      throw new UsageError(
        `no documentation or source files matched: ${paths.join(", ")}`,
      );
    }
  }
  return project;
}

/** Joins `dir` onto `root` unless `dir` is already absolute (e.g. `--out-dir=/tmp/mb`). */
export function resolveOutDir(root: string, dir: string): string {
  return isAbsolute(dir) ? dir : join(root, dir);
}

export async function extractFor(
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
 * Whether `check`/`--list` should run deep analysis. Nothing on the check
 * path reads what it produces (hovers, diagnostics, signatures live on the
 * IR for extract/build/coverage), so under the default "auto" it is pure
 * cold-start cost. Explicit `analysis: "deep"` keeps it (and its warnings);
 * `--changed` keeps it because impact tracing is stronger with references.
 */
function checkNeedsAnalysis(
  project: Project,
  opts: Pick<CommandOptions, "changed">,
): boolean {
  return project.config.analysis === "deep" || opts.changed !== undefined;
}

/** Shared by `selectCommand` and `checkCommand`: extract, select, then narrow by `--changed`. */
async function selectDocs(
  project: Project,
  opts: CommandOptions,
  full: boolean,
): Promise<DocumentationSet> {
  let docs = await extractFor(project, full, {
    skipAnalysis: !checkNeedsAnalysis(project, opts),
  });
  selectExamples(docs, {
    filter: opts.filter,
    only: opts.only,
    strict: opts.strict,
  });
  if (opts.changed !== undefined && !full) {
    const { selectAffected } = await import("../graph/select");
    const since = typeof opts.changed === "string" ? opts.changed : undefined;
    const selection = await selectAffected(docs, { since });
    if (selection.note) process.stderr.write(`${selection.note}\n`);
    if (selection.mode === "affected") {
      for (const [id, reasons] of selection.reasons) {
        const ex = docs.examples.find((e) => e.id === id);
        process.stderr.write(`  ${ex?.title ?? id} ← ${reasons.join("; ")}\n`);
      }
      docs = selection.docs;
    }
  }
  return docs;
}

// ── extract ──────────────────────────────────────────────────────────────

export interface ExtractResult {
  project: Project;
  docs: DocumentationSet;
}

export async function extractCommand(
  opts: CommandOptions,
): Promise<ExtractResult> {
  const project = await resolveProject({
    root: opts.root,
    paths: opts.paths,
    overrides: buildOverrides(opts),
    noConfigFile: opts.noConfig,
  });
  const docs = await extractFor(project, opts.full ?? false);
  return { project, docs };
}

// ── check --list ─────────────────────────────────────────────────────────

export interface ListedExample {
  id: string;
  kind: ExampleKind;
  language: Example["language"];
  docFile: string;
  line: number;
  title: string;
  group?: string;
}

export interface SelectResult {
  project: Project;
  examples: ListedExample[];
}

export async function selectCommand(
  opts: CommandOptions,
): Promise<SelectResult> {
  const project = await resolveProject({
    root: opts.root,
    paths: opts.paths,
    overrides: buildOverrides(opts),
    noConfigFile: opts.noConfig,
  });
  const docs = await selectDocs(project, opts, opts.full ?? false);
  return {
    project,
    examples: docs.examples.map((e) => ({
      id: e.id,
      kind: e.kind,
      language: e.language,
      docFile: e.source.file,
      line: e.source.start.line,
      title: e.title,
      ...(e.group ? { group: e.group } : {}),
    })),
  };
}

// ── check ────────────────────────────────────────────────────────────────

export interface CheckCommandOptions extends CommandOptions {
  timeoutMs?: number;
  bail?: boolean | number;
  signal?: AbortSignal;
}

export interface CheckResult {
  project: Project;
  result: RunResult;
}

export async function checkCommand(
  opts: CheckCommandOptions,
): Promise<CheckResult> {
  const project = await resolveProject({
    root: opts.root,
    paths: opts.paths,
    overrides: buildOverrides(opts),
    noConfigFile: opts.noConfig,
  });
  const full = opts.full ?? false;
  const docs = await selectDocs(project, opts, full);
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
    timeoutMs: opts.timeoutMs,
    bail: opts.bail,
    signal: opts.signal,
  });
  return { project, result };
}

// ── coverage ─────────────────────────────────────────────────────────────

export interface CoverageCommandOptions extends CommandOptions {
  check?: boolean;
}

export interface CoverageResult {
  project: Project;
  report: CoverageReport;
  gates?: { pass: boolean; failures: string[] };
}

export async function coverageCommand(
  opts: CoverageCommandOptions,
): Promise<CoverageResult> {
  const project = await resolveProject({
    root: opts.root,
    paths: opts.paths,
    overrides: buildOverrides(opts),
    noConfigFile: opts.noConfig,
  });
  const docs = await extractFor(project, opts.full ?? false);
  const { checkCoverage, coverage } = await import("../graph/queries");
  const report = coverage(docs);
  let gates: { pass: boolean; failures: string[] } | undefined;
  if (opts.check) {
    const gate = checkCoverage(docs, project.config.coverage ?? {}, report);
    gates = { pass: gate.pass, failures: gate.failures };
  }
  return { project, report, gates };
}

// ── impact ───────────────────────────────────────────────────────────────

export interface ImpactCommandOptions extends CommandOptions {
  /** Explicit changed-file args from the CLI positionals, not a project filter. */
  changedPaths?: string[];
}

export interface ImpactResult {
  project: Project;
  docs: DocumentationSet;
  changedFiles: string[];
  /** Omitted when no changes were detected (nothing to compute impact for). */
  impact?: Impact;
}

export async function impactCommand(
  opts: ImpactCommandOptions,
): Promise<ImpactResult> {
  const project = await resolveProject({
    root: opts.root,
    paths: [],
    overrides: buildOverrides(opts),
    noConfigFile: opts.noConfig,
  });
  const docs = await extractFor(project, opts.full ?? false);

  let changed: string[];
  let topLevel: string | undefined;
  if (opts.changedPaths && opts.changedPaths.length > 0) {
    const { gitTopLevel } = await import("../graph/git");
    const { isWithin, toProjectRelative } = await import("../graph/paths");
    const { resolve: pathResolve } = await import("node:path");
    topLevel = gitTopLevel(project.root);
    changed = [];
    for (const p of opts.changedPaths) {
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
    const git = changedFiles(project.root, opts.since);
    if (!git.available) {
      throw new UsageError(
        "not a git repository — pass changed files as arguments",
      );
    }
    changed = git.changedFiles;
    topLevel = git.topLevel;
  }

  if (changed.length === 0) {
    process.stderr.write("no changes detected\n");
    return { project, docs, changedFiles: changed };
  }

  const { computeImpact } = await import("../graph/impact");
  const impact = await computeImpact(docs, changed, { topLevel });
  return { project, docs, changedFiles: changed, impact };
}
