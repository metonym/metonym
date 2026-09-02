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

  // Handle: import "m"
  const bareImport = importStmt.match(/^import\s+["'](.+?)["']\s*;?\s*$/);
  if (bareImport) {
    return `${leadingWhitespace}await import(${JSON.stringify(bareImport[1])});`;
  }

  // Handle: import * as ns from "m"
  const starImport = importStmt.match(
    /^import\s+\*\s+as\s+(\w+)\s+from\s+["'](.+?)["']\s*;?\s*$/,
  );
  if (starImport) {
    const [, name, path] = starImport;
    return `${leadingWhitespace}const ${name} = await import(${JSON.stringify(path)});`;
  }

  // Handle: import d from "m"
  const defaultImport = importStmt.match(
    /^import\s+(\w+)\s+from\s+["'](.+?)["']\s*;?\s*$/,
  );
  if (defaultImport) {
    const [, name, path] = defaultImport;
    return `${leadingWhitespace}const { default: ${name} } = await import(${JSON.stringify(path)});`;
  }

  // Handle: import { a, b as c } from "m" or import d, { a as b } from "m"
  const complexImport = importStmt.match(
    /^import\s+([^;]+?)\s+from\s+["'](.+?)["']\s*;?\s*$/,
  );
  if (complexImport) {
    const [, specs, path] = complexImport;
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

    return `${leadingWhitespace}const { ${transformedSpecs.join(", ")} } = await import(${JSON.stringify(path)});`;
  }

  return line;
}

/**
 * Transform body lines: rewrite top-level static imports in place.
 */
function transformBodyLines(lines: string[]): string[] {
  return lines.map((line) => {
    const trimmed = line.trimStart();
    if (trimmed.startsWith("import ")) {
      return transformImportLine(line);
    }
    return line;
  });
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
      counter.addLine(testLines[testLines.length - 1]);
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
      testLines.push(`    expect(__threw).toBe(true);`);
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
  opts?: { jsxImportSource?: string },
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

  const headerLines = [
    `// ${testFileName} — generated by metonym v${TOOL_VERSION}. DO NOT EDIT.`,
    `// source: ${document.file}`,
    `import { describe, test, expect } from "bun:test";`,
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

  return {
    code: code.join(""),
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
 * One GeneratedTest per Document with executable examples.
 *
 * @param docs - The documentation set to generate tests from
 * @param opts - Optional generation options (e.g., jsxImportSource for tsx/jsx examples)
 */
export function generate(
  docs: DocumentationSet,
  opts?: { jsxImportSource?: string },
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

    const hasExecutable = examples.some(
      (ex) => ex.kind !== "ignored" && ex.kind !== "no-run",
    );
    if (!hasExecutable) {
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
