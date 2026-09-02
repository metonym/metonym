/**
 * Markdown renderer: annotate source docs with example statuses.
 * For each document with origin "readme"/"markdown": read the original text,
 * emit an annotated copy with a header comment and status lines after fences.
 * For JSDoc-origin: emit a summary .examples.md file listing all examples.
 */

import type {
  Document,
  DocumentationSet,
  ExampleResult,
  RenderedFile,
  Renderer,
  RenderOptions,
  RunResult,
} from "../ir/types";
import { TOOL_VERSION } from "../ir/types";

export const markdownRenderer: Renderer = {
  name: "markdown",
  async render(
    docs: DocumentationSet,
    options?: RenderOptions,
  ): Promise<{ files: RenderedFile[] }> {
    const files: RenderedFile[] = [];
    const results = options?.results;

    const resultMap = new Map<string, ExampleResult>();
    if (results) {
      for (const result of results.results) {
        resultMap.set(result.exampleId, result);
      }
    }

    for (const doc of docs.documents) {
      if (doc.origin === "readme" || doc.origin === "markdown") {
        const originalText = await Bun.file(`${docs.root}/${doc.file}`).text();
        const annotated = annotateMarkdownDoc(
          originalText,
          docs,
          doc,
          resultMap,
          results,
        );
        files.push({
          path: doc.file,
          contents: annotated,
        });
      }
    }

    for (const doc of docs.documents) {
      if (doc.origin === "jsdoc") {
        const summary = emitJsdocSummary(docs, doc, resultMap);
        files.push({
          path: `${doc.file}.examples.md`,
          contents: summary,
        });
      }
    }

    return { files };
  },
};

function annotateMarkdownDoc(
  text: string,
  docs: DocumentationSet,
  doc: Document,
  resultMap: Map<string, ExampleResult>,
  results?: RunResult,
): string {
  const lines = text.split("\n");

  const docExamples = docs.examples.filter((ex) => ex.documentId === doc.id);
  let headerComment = "";
  if (results) {
    const docResults = docExamples
      .map((ex) => resultMap.get(ex.id))
      .filter(Boolean);
    const passed = docResults.filter((r) => r?.status === "passed").length;
    const failed = docResults.filter((r) => r?.status === "failed").length;
    const pending = docResults.filter((r) => r?.status === "pending").length;
    headerComment = `<!-- verified by metonym v${TOOL_VERSION} — ${docExamples.length} examples: ${passed} passed · ${failed} failed · ${pending} pending -->`;
  } else {
    headerComment = `<!-- extracted by metonym v${TOOL_VERSION} — ${docExamples.length} examples -->`;
  }

  const insertions: Map<number, string> = new Map();

  for (const ex of docExamples) {
    const result = resultMap.get(ex.id);
    const fenceEndLine = ex.fenceSource.end.line; // 1-indexed

    let statusLine = "";
    if (result) {
      switch (result.status) {
        case "passed":
          statusLine = `> metonym: ✓ passed (${result.durationMs}ms)`;
          break;
        case "failed": {
          const docLoc = result.failure?.doc
            ? `${result.failure.doc.file}:${result.failure.doc.line}`
            : `${result.docFile}:${ex.fenceSource.end.line}`;
          statusLine = `> metonym: ✗ failed — Expected: ${result.failure?.expected ?? "?"} · Received: ${result.failure?.received ?? "?"} (${docLoc})`;
          break;
        }
        case "pending":
          statusLine = `> metonym: ○ pending`;
          break;
        default:
          statusLine = `> metonym: · not run`;
      }
    } else {
      statusLine = `> metonym: · not run`;
    }

    insertions.set(fenceEndLine, statusLine);
  }

  // Reconstruct text with insertions, working bottom-up to preserve line numbers
  const sortedLines = Array.from(insertions.keys()).sort((a, b) => b - a);

  for (const lineNum of sortedLines) {
    const insertIndex = lineNum; // After line N means at index N (0-indexed)
    lines.splice(insertIndex, 0, insertions.get(lineNum) ?? "");
  }

  lines.unshift(headerComment);

  return lines.join("\n");
}

function emitJsdocSummary(
  docs: DocumentationSet,
  doc: Document,
  resultMap: Map<string, ExampleResult>,
): string {
  const lines: string[] = [];

  for (const ex of docs.examples) {
    if (ex.documentId === doc.id) {
      lines.push(`## ${ex.title}`);
      lines.push("");
      lines.push(`\`\`\`${ex.language}`);
      lines.push(ex.code.trimEnd());
      lines.push("```");
      lines.push("");

      const result = resultMap.get(ex.id);
      if (result) {
        switch (result.status) {
          case "passed":
            lines.push(`> metonym: ✓ passed (${result.durationMs}ms)`);
            break;
          case "failed":
            lines.push(
              `> metonym: ✗ failed — Expected: ${result.failure?.expected ?? "?"} · Received: ${result.failure?.received ?? "?"}`,
            );
            break;
          case "pending":
            lines.push(`> metonym: ○ pending`);
            break;
          default:
            lines.push(`> metonym: · not run`);
        }
      } else {
        lines.push(`> metonym: · not run`);
      }
      lines.push("");
    }
  }

  return lines.join("\n");
}
