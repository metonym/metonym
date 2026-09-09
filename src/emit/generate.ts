/**
 * Test file emitter for metonym.
 *
 * Generates deterministic, human-readable bun:test files from extracted examples.
 * Line invariant: each example's body appears as CONTIGUOUS lines with 1:1
 * correspondence to authored code.
 */

import {
  type Document,
  type DocumentationSet,
  type Example,
  type GeneratedTest,
  type SidecarEntry,
  type SidecarMap,
  TOOL_VERSION,
} from "../ir/types.ts";
import {
  isCompleteImportStatement,
  joinStatementLines,
} from "../parse/imports.ts";
import { transformOutputComments } from "../parse/outputs.ts";
import { getTranspiler } from "../parse/transpiler.ts";

/**
 * Line number tracker for maintaining the line invariant.
 * Tracks output line numbers (1-indexed) as we build the file.
 */
class LineCounter {
  private line = 1;

  get current(): number {
    return this.line;
  }

  advance(count: number): void {
    this.line += count;
  }

  addLine(content: string): void {
    // Count newlines in the content (not split elements which counts extra empty string)
    this.line += (content.match(/\n/g) || []).length;
  }
}

/** Optional trailing `with { ... }` / `assert { ... }` import attributes clause. */
const ATTR_CLAUSE_SOURCE = "(?:\\s+(?:with|assert)\\s*(\\{[^}]*\\}))?";

/** Renders a captured import-attributes clause as a second `import()` argument. */
function importOptionsArg(attrs?: string): string {
  return attrs ? `, { with: ${attrs} }` : "";
}

/**
 * Transforms import statements to dynamic async imports.
 * Preserves leading whitespace and handles all import forms.
 */
function transformImportLine(line: string): string {
  const match = line.match(/^(\s*)(import\s+.+)/);
  if (!match) return line;

  const [, leadingWhitespace, importStmt] = match;

  if (importStmt.match(/^import\s+type\s+/)) {
    return `${leadingWhitespace}// metonym: type-only import elided`;
  }

  if (importStmt.includes("import {")) {
    const typeOnlyPattern = /^import\s+\{\s*type\s+/;
    if (typeOnlyPattern.test(importStmt)) {
      return `${leadingWhitespace}// metonym: type-only import elided`;
    }
  }

  // Handle: import x = require("m")
  const requireImport = importStmt.match(
    /^import\s+(\w+)\s*=\s*require\(\s*["'](.+?)["']\s*\)\s*;?\s*$/,
  );
  if (requireImport) {
    const [, name, path] = requireImport;
    return `${leadingWhitespace}const ${name} = await import(${JSON.stringify(path)}).then((m) => m.default ?? m);`;
  }

  // Handle: import "m" [with { ... }]
  const bareImport = importStmt.match(
    new RegExp(`^import\\s+["'](.+?)["']${ATTR_CLAUSE_SOURCE}\\s*;?\\s*$`),
  );
  if (bareImport) {
    const [, path, attrs] = bareImport;
    return `${leadingWhitespace}await import(${JSON.stringify(path)}${importOptionsArg(attrs)});`;
  }

  // Handle: import * as ns from "m" [with { ... }]
  const starImport = importStmt.match(
    new RegExp(
      `^import\\s+\\*\\s+as\\s+(\\w+)\\s+from\\s+["'](.+?)["']${ATTR_CLAUSE_SOURCE}\\s*;?\\s*$`,
    ),
  );
  if (starImport) {
    const [, name, path, attrs] = starImport;
    return `${leadingWhitespace}const ${name} = await import(${JSON.stringify(path)}${importOptionsArg(attrs)});`;
  }

  // Handle: import d from "m" [with { ... }]
  const defaultImport = importStmt.match(
    new RegExp(
      `^import\\s+(\\w+)\\s+from\\s+["'](.+?)["']${ATTR_CLAUSE_SOURCE}\\s*;?\\s*$`,
    ),
  );
  if (defaultImport) {
    const [, name, path, attrs] = defaultImport;
    return `${leadingWhitespace}const { default: ${name} } = await import(${JSON.stringify(path)}${importOptionsArg(attrs)});`;
  }

  // Handle: import { a, b as c } from "m" or import d, { a as b } from "m" [with { ... }]
  const complexImport = importStmt.match(
    new RegExp(
      `^import\\s+([^;]+?)\\s+from\\s+["'](.+?)["']${ATTR_CLAUSE_SOURCE}\\s*;?\\s*$`,
    ),
  );
  if (complexImport) {
    const [, specs, path, attrs] = complexImport;
    const transformedSpecs: string[] = [];

    const braceMatch = specs.match(/\{\s*([^}]*)\s*\}/);
    if (braceMatch) {
      const namedImportString = braceMatch[1];
      const namedImports = namedImportString.split(",").map((s) => s.trim());

      for (const named of namedImports) {
        if (named && !named.startsWith("type ")) {
          // Transform "a as b" to "a: b" for destructuring
          const transformed = named.replace(/\s+as\s+/g, ": ");
          transformedSpecs.push(transformed);
        }
      }

      const beforeBraces = specs
        .substring(0, braceMatch.index)
        .trim()
        .replace(/,\s*$/, "");
      if (beforeBraces && !beforeBraces.startsWith("type ")) {
        transformedSpecs.unshift(`default: ${beforeBraces}`);
      }
    } else {
      const part = specs.trim();
      if (!part.startsWith("type ")) {
        transformedSpecs.push(part);
      }
    }

    if (transformedSpecs.length === 0) {
      return `${leadingWhitespace}// metonym: type-only import elided`;
    }

    return `${leadingWhitespace}const { ${transformedSpecs.join(", ")} } = await import(${JSON.stringify(path)}${importOptionsArg(attrs)});`;
  }

  return line;
}

const EXPORT_DECL_KEYWORDS =
  /^export\s+(const|let|var|function|async\s+function|class|enum|type|interface)\b/;

/** `export { ... }`, `export * from "m"`, `export { a } from "m"`. */
function isReexportLine(trimmed: string): boolean {
  return /^export\s*(\*|\{)/.test(trimmed);
}

function isCompleteExportStatement(text: string): boolean {
  const trimmed = text.trim();
  return (
    /from\s+["'][^"']+["']\s*;?\s*$/.test(trimmed) ||
    /^export\s*\{[^{}]*\}\s*;?\s*$/.test(trimmed) ||
    /^export\s*\*\s*;?\s*$/.test(trimmed)
  );
}

/** `export const x = 1` → `const x = 1` (drops the export keyword only). */
function transformExportDeclLine(line: string): string {
  return line.replace(/^(\s*)export\s+/, "$1");
}

/**
 * `export default <expr>` → `const __default = <expr>` when the rest is a
 * keepable expression, otherwise a no-op comment.
 */
function transformExportDefaultLine(line: string): string {
  const match = line.match(/^(\s*)export\s+default\s*(.*)$/);
  if (!match) return line;
  const [, leadingWhitespace, rest] = match;
  const trimmedRest = rest.trim().replace(/;\s*$/, "");
  if (trimmedRest === "") {
    return `${leadingWhitespace}// metonym: export default removed`;
  }
  return `${leadingWhitespace}const __default = ${trimmedRest};`;
}

/**
 * Transform body lines: rewrite top-level static imports in place, strip
 * top-level `export`, drop shebangs, and rewrite `expr // => value`
 * expected-output comments into `expect(...)` assertions. Statements
 * spanning multiple lines (imports, `export … from`, multi-line `// =>`
 * values) are joined, transformed onto the first line, and padded with
 * continuation-marker comments to keep line count.
 */
function transformBodyLines(lines: string[]): string[] {
  return transformOutputComments(transformImportsAndExports(lines));
}

function transformImportsAndExports(lines: string[]): string[] {
  const result: string[] = [];
  let i = 0;

  if (lines.length > 0 && lines[0].startsWith("#!")) {
    result.push("// metonym: shebang removed");
    i = 1;
  }

  while (i < lines.length) {
    const trimmed = lines[i].trimStart();

    if (trimmed.startsWith("import ")) {
      const { statement, consumed } = joinStatementLines(
        lines,
        i,
        isCompleteImportStatement,
      );
      result.push(transformImportLine(statement));
      for (let k = 1; k < consumed; k++) {
        result.push("// metonym: import continued");
      }
      i += consumed;
      continue;
    }

    if (isReexportLine(trimmed)) {
      const { consumed } = joinStatementLines(
        lines,
        i,
        isCompleteExportStatement,
      );
      result.push("// metonym: export removed");
      for (let k = 1; k < consumed; k++) {
        result.push("// metonym: import continued");
      }
      i += consumed;
      continue;
    }

    if (EXPORT_DECL_KEYWORDS.test(trimmed)) {
      result.push(transformExportDeclLine(lines[i]));
      i++;
      continue;
    }

    if (/^export\s+default\b/.test(trimmed)) {
      result.push(transformExportDefaultLine(lines[i]));
      i++;
      continue;
    }

    result.push(lines[i]);
    i++;
  }

  return result;
}

/**
 * Group examples by (group?, documentId).
 * Returns Map from "group:X" or "ungrouped:N" to array of examples.
 */
function groupExamples(examples: Example[]): Map<string, Example[]> {
  const groups = new Map<string, Example[]>();

  for (const example of examples) {
    const groupKey = example.group
      ? `group:${example.group}`
      : `ungrouped:${example.id}`;
    if (!groups.has(groupKey)) {
      groups.set(groupKey, []);
    }
    groups.get(groupKey)?.push(example);
  }

  return groups;
}

/**
 * Group examples by documentId. One pass, preserves source order.
 */
function examplesByDocument(examples: Example[]): Map<string, Example[]> {
  const map = new Map<string, Example[]>();
  for (const example of examples) {
    const list = map.get(example.documentId);
    if (list) {
      list.push(example);
    } else {
      map.set(example.documentId, [example]);
    }
  }
  return map;
}

/**
 * Check if a document has any examples with tsx or jsx language.
 */
function hasJsxExamples(examples: Example[]): boolean {
  return examples.some(
    (ex) =>
      ex.kind !== "ignored" && (ex.language === "tsx" || ex.language === "jsx"),
  );
}

/**
 * Generate a single test string for one or more examples (grouped or single).
 */
function generateTest(
  examples: Example[],
  counter: LineCounter,
  _sidecarEntries: SidecarEntry[],
): { testCode: string; entries: SidecarEntry[] } {
  const entries: SidecarEntry[] = [];
  const testLines: string[] = [];

  const firstEx = examples[0];
  const docFile = firstEx.source.file;
  const docLine = firstEx.source.start.line;

  if (firstEx.kind === "pending") {
    testLines.push(
      `  // metonym:example ${firstEx.id} source=${docFile}:${docLine}`,
    );
    counter.advance(1);
    testLines.push(
      `  test.todo(${JSON.stringify(`${firstEx.title} (${docFile}:${docLine})`)})`,
    );
    counter.advance(1);

    return {
      testCode: `${testLines.join(";\n")};\n`,
      entries: [
        {
          exampleId: firstEx.id,
          title: firstEx.title,
          kind: "pending",
          docFile,
          docCodeStartLine: docLine,
          genCodeStartLine: counter.current - 1,
          genCodeEndLine: counter.current - 1,
        },
      ],
    };
  }

  testLines.push(
    `  // metonym:example ${firstEx.id} source=${docFile}:${docLine}`,
  );
  counter.advance(1);

  const testName =
    examples.length === 1
      ? firstEx.title
      : `group:${firstEx.group || "unnamed"}`;
  testLines.push(
    `  test(${JSON.stringify(`${testName} (${docFile}:${docLine})`)}, async () => {`,
  );
  counter.advance(1);

  for (let i = 0; i < examples.length; i++) {
    const example = examples[i];

    if (i > 0) {
      testLines.push("");
      counter.advance(1);

      testLines.push(
        `    // metonym:example ${example.id} source=${example.source.file}:${example.source.start.line}`,
      );
      counter.advance(1);
    }

    const bodyLines = example.code.split("\n");
    const transformedLines = transformBodyLines(bodyLines);

    const genCodeStartLine = counter.current;

    if (example.kind === "throws") {
      testLines.push(`    let __threw = false;`);
      counter.advance(1);
      testLines.push(`    try {`);
      counter.advance(1);

      for (const line of transformedLines) {
        testLines.push(`      ${line}`);
        counter.advance(1);
      }

      testLines.push(`    } catch {`);
      counter.advance(1);
      testLines.push(`      __threw = true;`);
      counter.advance(1);
      testLines.push(`    }`);
      counter.advance(1);
      testLines.push(
        `    if (!__threw) throw new Error("expected code to throw");`,
      );
      counter.advance(1);
    } else {
      for (const line of transformedLines) {
        testLines.push(`    ${line}`);
        counter.advance(1);
      }
    }

    const genCodeEndLine = counter.current - 1;

    entries.push({
      exampleId: example.id,
      title: example.title,
      kind: example.kind,
      docFile: example.source.file,
      docCodeStartLine: example.source.start.line,
      genCodeStartLine,
      genCodeEndLine,
    });
  }

  testLines.push(`  });`);
  counter.advance(1);

  return {
    testCode: `${testLines.join("\n")}\n`,
    entries,
  };
}

/**
 * Generate test file code and sidecar for one document.
 */
function generateTestFile(
  document: Document,
  examples: Example[],
  opts?: { jsxImportSource?: string; inject?: boolean },
): {
  code: string;
  path: string;
  map: SidecarMap;
  diagnostics: string[];
} {
  const counter = new LineCounter();
  const sidecarEntries: SidecarEntry[] = [];
  const diagnostics: string[] = [];

  const hasJsx = hasJsxExamples(examples);
  const fileExtension = hasJsx ? "tsx" : "ts";
  const testFileName = `${document.file}.test.${fileExtension}`;
  const needsPragma = hasJsx && opts?.jsxImportSource;

  const code: string[] = [];

  // Add JSX pragma if needed (must be first line, before header comment)
  if (needsPragma) {
    const pragma = `/* @jsxImportSource ${opts.jsxImportSource} */`;
    code.push(`${pragma}\n`);
    counter.advance(1);
  }

  const inject = opts?.inject ?? true;
  const bunTestImport = inject
    ? `import { describe, test, expect } from "bun:test";`
    : `import { describe, test } from "bun:test";`;

  const headerLines = [
    `// ${testFileName} — generated by metonym v${TOOL_VERSION}. DO NOT EDIT.`,
    `// source: ${document.file}`,
    bunTestImport,
    ``,
    `describe(${JSON.stringify(document.file)}, () => {`,
  ];

  code.push(`${headerLines.join("\n")}\n`);
  counter.addLine(code[code.length - 1]);

  const documentExamples = examples.filter((ex) => ex.kind !== "ignored");

  documentExamples.sort(
    (a, b) => a.source.start.offset - b.source.start.offset,
  );

  const groups = groupExamples(documentExamples);
  const sortedGroupKeys = Array.from(groups.keys()).sort();

  for (const groupKey of sortedGroupKeys) {
    const examplesInGroup = groups.get(groupKey);
    if (!examplesInGroup) continue;

    const executableExamples = examplesInGroup.filter(
      (ex) => ex.kind !== "no-run",
    );
    const noRunExamples = examplesInGroup.filter((ex) => ex.kind === "no-run");

    for (const example of noRunExamples) {
      try {
        getTranspiler(example.language).transformSync(example.code);
      } catch (e) {
        const message = e instanceof Error ? e.message : String(e);
        diagnostics.push(
          `${example.source.file}:${example.source.start.line} no-run example failed to transpile: ${message}`,
        );
      }
    }

    if (executableExamples.length > 0) {
      const { testCode, entries } = generateTest(
        executableExamples,
        counter,
        sidecarEntries,
      );
      code.push(testCode);
      sidecarEntries.push(...entries);
    }
  }

  code.push(`});\n`);

  const fullCode = code.join("");

  try {
    getTranspiler(fileExtension).transformSync(fullCode);
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    diagnostics.push(
      `${document.file}: generated test does not parse — ${message}`,
    );
  }

  return {
    code: fullCode,
    path: testFileName,
    map: {
      version: 1,
      source: document.file,
      testFile: testFileName,
      entries: sidecarEntries,
    },
    diagnostics,
  };
}

/**
 * Generate test files from a DocumentationSet.
 * One GeneratedTest per Document that has any (non-ignored) examples, even
 * when they're all `no-run` — that's the only way their transpile
 * diagnostics reach the caller.
 *
 * @param docs - The documentation set to generate tests from
 * @param opts - Optional generation options (jsxImportSource for tsx/jsx
 *   examples; inject controls whether `expect` is auto-imported, default true)
 */
export function generate(
  docs: DocumentationSet,
  opts?: { jsxImportSource?: string; inject?: boolean },
): GeneratedTest[] {
  const result: GeneratedTest[] = [];
  const byDoc = examplesByDocument(docs.examples);

  const sortedDocs = [...docs.documents].sort((a, b) =>
    a.file.localeCompare(b.file),
  );

  for (const document of sortedDocs) {
    if (document.exampleIds.length === 0) {
      continue;
    }

    const examples = byDoc.get(document.id);
    if (!examples) {
      continue;
    }

    const { code, path, map, diagnostics } = generateTestFile(
      document,
      examples,
      opts,
    );

    result.push({
      path,
      code,
      map,
      ...(diagnostics.length > 0 && { diagnostics }),
    });
  }

  return result;
}
