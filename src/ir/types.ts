/**
 * metonym Documentation IR.
 *
 * Every stage (parse → extract → generate → run → render) consumes and
 * produces these shapes. All file paths are repo-relative with posix
 * separators. All output ordering is: file path, then source offset.
 */

export const IR_VERSION = 1 as const;
export const TOOL_NAME = "metonym" as const;
export const TOOL_VERSION = "0.1.0" as const;

// ── Locations ────────────────────────────────────────────────────────────

/** line is 1-indexed, column is 1-indexed, offset is a 0-indexed byte offset. */
export interface Position {
  line: number;
  column: number;
  offset: number;
}

export interface SourceLocation {
  file: string;
  start: Position;
  end: Position;
}

// ── Documents & examples ─────────────────────────────────────────────────

export type DocumentOrigin = "readme" | "markdown" | "mdx" | "jsdoc" | "source";

export interface Document {
  id: string; // "doc:" + relative path
  file: string;
  origin: DocumentOrigin;
  title?: string; // first heading, if any
  exampleIds: string[];
}

export type ExampleKind =
  | "assertion"
  | "no-run"
  | "throws"
  | "pending"
  | "ignored";

export interface Example {
  id: string; // see ids.ts
  documentId: string;
  /** Location of the code body (first content line → last content line). */
  source: SourceLocation;
  /** Location including the fence/tag delimiters. */
  fenceSource: SourceLocation;
  language: "ts" | "js" | "tsx" | "jsx";
  /** Exactly as authored — no injection or import transforms applied. */
  code: string;
  kind: ExampleKind;
  group?: string;
  owner?: string; // symbol id, for JSDoc examples
  /** Deterministic: "«nearest heading» › example N" (markdown) or "«symbol» › example N" (jsdoc). */
  title: string;
  /** Per-identifier hover info for static prerendering, deep analysis only. */
  hovers?: HoverInfo[];
  /** Type-checker diagnostics against this example's code, deep analysis only. */
  diagnostics?: Diagnostic[];
}

/**
 * Hover info for one identifier occurrence in an example's authored code.
 * Positions are relative to `example.code`: `start` is a 0-indexed byte
 * offset; `line`/`column` are 1-indexed within the snippet.
 */
export interface HoverInfo {
  start: number;
  length: number;
  line: number;
  column: number;
  /** Quick-info text (what an editor shows on hover), e.g. a signature. */
  info: string;
  /** JSDoc prose for the hovered symbol, when available. */
  docs?: string;
  /** IR symbol id when the identifier resolves to a tracked export. */
  symbol?: string;
}

/**
 * A TypeScript compiler diagnostic against one example's authored code.
 * Positions are relative to `example.code`, same convention as HoverInfo.
 */
export interface Diagnostic {
  severity: "error" | "warning";
  message: string;
  start: number;
  length: number;
  line: number;
  column: number;
  /** TypeScript diagnostic code, e.g. 2345. */
  code: number;
}

export type DeclKind =
  | "function"
  | "class"
  | "const"
  | "let"
  | "var"
  | "enum"
  | "type"
  | "interface"
  | "default"
  | "reexport"
  | "unknown";

export interface SymbolInfo {
  id: string; // "sym:" + file + ":" + exportName
  file: string;
  name: string; // export name; "default" for default exports
  imports: { path: string; kind: string }[];
  /** Declaration site, when the declaration scanner found it. */
  loc?: SourceLocation;
  declKind?: DeclKind;
  /** For `export … from "./x"` re-exports: the source module specifier. */
  reexportFrom?: string;
  /** JSDoc prose preceding the declaration, without tags. */
  description?: string;
  /** JSDoc tags: tag name (without @) → one entry per occurrence. */
  tags?: Record<string, string[]>;
  /** Type signature via the TS checker, deep analysis only. */
  signature?: string;
}

export type Relation =
  | { kind: "contains"; from: string; to: string } // document → example
  | { kind: "documents"; from: string; to: string } // document → symbol
  | { kind: "owns"; from: string; to: string } // symbol → example
  | { kind: "imports"; from: string; to: string } // example|symbol → module path
  | { kind: "references"; from: string; to: string } // example → symbol (imported binding used in code)
  | { kind: "calls"; from: string; to: string } // symbol → symbol (deep analysis only)
  | { kind: "generates"; from: string; to: string }; // example → generated test path

export interface DocumentationSet {
  irVersion: typeof IR_VERSION;
  tool: { name: typeof TOOL_NAME; version: string };
  /** Project root (absolute); not serialized comparisons — informational. */
  root: string;
  documents: Document[];
  examples: Example[]; // flat, ordered (file path, then offset)
  symbols: SymbolInfo[];
  relations: Relation[];
}

// ── Generated tests & sidecar maps ───────────────────────────────────────

/**
 * Line invariant: every example body line maps 1:1 into the generated file.
 * docLine = entry.docCodeStartLine + (genLine - entry.genCodeStartLine).
 * Import statements are rewritten in place, one line each, preserving count.
 */
export interface SidecarEntry {
  exampleId: string;
  title: string;
  kind: ExampleKind;
  docFile: string;
  docCodeStartLine: number; // 1-indexed line of the first body line in the doc
  genCodeStartLine: number; // 1-indexed line of the first body line in the generated file
  genCodeEndLine: number; // 1-indexed, inclusive
}

export interface SidecarMap {
  version: 1;
  source: string; // doc file this test file was generated from
  testFile: string; // generated test file path (relative to outDir)
  entries: SidecarEntry[];
}

export interface GeneratedTest {
  /** Path relative to outDir, e.g. "README.md.test.ts". */
  path: string;
  code: string;
  map: SidecarMap;
  /** Generation-time diagnostics (e.g. `no-run` transpile failures). */
  diagnostics?: string[];
}

// ── Run results ──────────────────────────────────────────────────────────

export type ExampleStatus = "passed" | "failed" | "pending" | "skipped";

export interface FailureInfo {
  /** Full failure message from bun (e.g. "expect(received).toBe(expected)…"). */
  message: string;
  expected?: string;
  received?: string;
  /** Remapped location in the original documentation, when remapping succeeded. */
  doc?: { file: string; line: number; column?: number };
  /** Location in the generated test file (always available on failure). */
  generated: { file: string; line?: number; column?: number };
  stack?: string;
}

export interface ExampleResult {
  exampleId: string;
  title: string;
  docFile: string;
  status: ExampleStatus;
  durationMs: number;
  failure?: FailureInfo;
  /** True when served from the result cache instead of executed. */
  fromCache?: boolean;
}

export interface RunResult {
  results: ExampleResult[];
  totals: {
    total: number;
    passed: number;
    failed: number;
    pending: number;
    skipped: number;
    durationMs: number;
    /** How many results were served from cache. */
    cached?: number;
  };
  /** Raw artifacts for debugging. */
  outDir: string;
  exitCode: number;
}

// ── Renderers ────────────────────────────────────────────────────────────

export interface RenderedFile {
  /** Path relative to the render output directory. */
  path: string;
  contents: string;
}

export interface RenderResult {
  files: RenderedFile[];
}

export interface RenderOptions {
  /** When present, renderers annotate examples with their run statuses. */
  results?: RunResult;
}

export interface Renderer<TOptions extends RenderOptions = RenderOptions> {
  name: string;
  render(
    docs: DocumentationSet,
    options?: TOptions,
  ): RenderResult | Promise<RenderResult>;
}

// ── Config & project ─────────────────────────────────────────────────────

export interface MetonymConfig {
  root: string;
  include: string[];
  exclude: string[];
  outDir: string;
  /** Fence languages considered executable. */
  languages: string[];
  /** Auto-import `expect`/`test` from bun:test when the example doesn't. */
  inject: boolean;
  /**
   * JSX import source for tsx/jsx examples (emitted as a jsxImportSource
   * pragma in generated test files). Unset → tsx/jsx examples still extract
   * and transpile, but running JSX requires a runtime Bun can resolve.
   */
  jsxImportSource?: string;
  /**
   * Symbol-analysis depth. "shallow": zero-dep scanners only.
   * "deep": use the TypeScript compiler (requires `typescript` installed in
   * the analyzed project, never a metonym runtime dependency).
   * "auto" (default): deep when `typescript` is resolvable, else shallow.
   */
  analysis?: "auto" | "shallow" | "deep";
  /** Documentation-coverage CI gates for `metonym coverage --check`. */
  coverage?: {
    /** Minimum % of exported symbols with documentation (0-100). */
    minDocumented?: number;
    /** Minimum % of exported symbols with executable examples (0-100). */
    minExamples?: number;
    /** Fail when any export lacks documentation entirely. */
    failOnUndocumented?: boolean;
    /** Fail when any example has a type error, deep analysis only. */
    failOnTypeErrors?: boolean;
  };
}

export const DEFAULT_CONFIG: Omit<MetonymConfig, "root"> = {
  include: ["README.md", "docs/**/*.{md,mdx}", "src/**/*.{ts,tsx,js,jsx}"],
  exclude: ["**/node_modules/**", "**/.git/**", "**/.metonym/**"],
  outDir: ".metonym/tests",
  languages: ["ts", "tsx", "js", "jsx"],
  inject: true,
};

export interface Project {
  root: string;
  config: MetonymConfig;
  /** Markdown documentation files (repo-relative, sorted). */
  docFiles: string[];
  /** TS/JS source files scanned for JSDoc examples and symbols (sorted). */
  sourceFiles: string[];
}
