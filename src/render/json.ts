/**
 * JSON renderer: serialize the DocumentationSet and results as JSON/JSONL.
 *
 * json: one file "metonym.ir.json" with the full IR (root replaced by ".")
 * jsonl: one file "metonym.examples.jsonl" with one JSON line per example
 */

import type {
  DocumentationSet,
  ExampleResult,
  RenderedFile,
  Renderer,
  RenderOptions,
} from "../ir/types";

export const jsonRenderer: Renderer = {
  name: "json",
  render(
    docs: DocumentationSet,
    options?: RenderOptions,
  ): { files: RenderedFile[] } {
    const irData = {
      ...docs,
      root: ".",
      results: options?.results ?? null,
    };

    const jsonContent = `${JSON.stringify(irData, null, 2)}\n`;

    return {
      files: [
        {
          path: "metonym.ir.json",
          contents: jsonContent,
        },
      ],
    };
  },
};

export const jsonlRenderer: Renderer = {
  name: "jsonl",
  render(
    docs: DocumentationSet,
    options?: RenderOptions,
  ): { files: RenderedFile[] } {
    const resultMap = new Map<string, ExampleResult>();
    if (options?.results) {
      for (const result of options.results.results) {
        resultMap.set(result.exampleId, result);
      }
    }

    const lines: string[] = [];
    for (const example of docs.examples) {
      const result = resultMap.get(example.id);
      const exampleData = result
        ? {
            ...example,
            status: result.status,
            durationMs: result.durationMs,
            failure: result.failure,
          }
        : example;

      lines.push(JSON.stringify(exampleData));
    }

    const jsonlContent = lines.join("\n") + (lines.length > 0 ? "\n" : "");

    return {
      files: [
        {
          path: "metonym.examples.jsonl",
          contents: jsonlContent,
        },
      ],
    };
  },
};
