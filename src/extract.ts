/**
 * extract(project) → DocumentationSet.
 * Pure over file contents: reads files, never executes or writes.
 *
 * Per-file functions are exported so the extraction cache can wrap
 * them and reuse `assembleDocumentationSet` for identical output.
 */

import type {
  Document,
  DocumentationSet,
  Example,
  Project,
  Relation,
  SymbolInfo,
} from "./ir/types";
import { IR_VERSION, TOOL_NAME, TOOL_VERSION } from "./ir/types";
import { lineOffsetsOf } from "./parse/fence";
import {
  extractDocComments,
  extractJsdoc,
  extractJsdocBlocks,
} from "./parse/jsdoc";
import { extractMarkdown } from "./parse/markdown";
import { scanSymbols } from "./parse/symbols";
import { getTranspiler } from "./parse/transpiler";

/** Extraction output for one file — the unit the extraction cache stores. */
export interface FilePart {
  file: string;
  document: Document | null;
  examples: Example[];
  symbols: SymbolInfo[];
}

export async function extractDocFile(
  root: string,
  file: string,
  languages: string[],
  text?: string,
): Promise<FilePart> {
  const body = text ?? (await Bun.file(`${root}/${file}`).text());
  const { document, examples } = extractMarkdown(body, { file, languages });
  return { file, document, examples, symbols: [] };
}

export async function extractSourceFile(
  root: string,
  file: string,
  languages: string[],
  text?: string,
): Promise<FilePart> {
  const body = text ?? (await Bun.file(`${root}/${file}`).text());
  const lines = body.split("\n");
  const lineOffsets = lineOffsetsOf(lines);
  const blocks = extractJsdocBlocks(body, lines);
  const { document, examples } = extractJsdoc(body, {
    file,
    languages,
    blocks,
    lines,
    lineOffsets,
  });
  const symbols = scanSymbols(file, body);

  const byName = new Map(symbols.map((s) => [s.name, s]));
  for (const dc of extractDocComments(body, { file, blocks, lines })) {
    if (!dc.declName) continue;
    const sym = byName.get(dc.declName);
    if (!sym) continue;
    if (dc.description) sym.description = dc.description;
    if (Object.keys(dc.tags).length > 0) sym.tags = dc.tags;
  }

  return { file, document, examples, symbols };
}

export function assembleDocumentationSet(
  root: string,
  parts: FilePart[],
): DocumentationSet {
  const documents: Document[] = [];
  const examples: Example[] = [];
  const symbols: SymbolInfo[] = [];
  const relations: Relation[] = [];

  for (const part of parts) {
    if (part.document) {
      documents.push(part.document);
      examples.push(...part.examples);
    }
    symbols.push(...part.symbols);
  }

  documents.sort((a, b) => a.file.localeCompare(b.file));
  examples.sort(
    (a, b) =>
      a.source.file.localeCompare(b.source.file) ||
      a.source.start.offset - b.source.start.offset,
  );
  symbols.sort(
    (a, b) => a.file.localeCompare(b.file) || a.name.localeCompare(b.name),
  );

  const symbolIds = new Set(symbols.map((s) => s.id));
  for (const ex of examples) {
    relations.push({ kind: "contains", from: ex.documentId, to: ex.id });
    if (ex.owner && symbolIds.has(ex.owner)) {
      relations.push({ kind: "owns", from: ex.owner, to: ex.id });
      relations.push({ kind: "documents", from: ex.documentId, to: ex.owner });
    }
    for (const spec of exampleImports(ex.code, ex.language)) {
      relations.push({ kind: "imports", from: ex.id, to: spec });
    }
  }
  for (const sym of symbols) {
    for (const imp of sym.imports) {
      relations.push({ kind: "imports", from: sym.id, to: imp.path });
    }
  }

  return {
    irVersion: IR_VERSION,
    tool: { name: TOOL_NAME, version: TOOL_VERSION },
    root,
    documents,
    examples,
    symbols,
    relations,
  };
}

/** Module specifiers statically imported by an example's code. */
export function exampleImports(
  code: string,
  language: "ts" | "tsx" | "js" | "jsx",
): string[] {
  if (!code.includes("import")) {
    return [];
  }
  try {
    return getTranspiler(language)
      .scanImports(code)
      .map((i) => i.path);
  } catch {
    return [];
  }
}

/**
 * Files in flight at once. Unbounded Promise.all reads the whole corpus
 * into memory before the (single-threaded) parse can drain it; bounding it
 * trims peak RSS ~10% on large repos with no measurable time cost. Below
 * the limit this is identical to Promise.all.
 */
export const EXTRACT_CONCURRENCY = 128;

/** Promise.all with at most `limit` tasks running; results keep input order. */
export async function mapPool<T, R>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i]);
    }
  };
  const workers = Array.from({ length: Math.min(limit, items.length) }, worker);
  await Promise.all(workers);
  return results;
}

export async function extract(project: Project): Promise<DocumentationSet> {
  const { root } = project;
  const languages = project.config.languages;
  const [docParts, sourceParts] = await Promise.all([
    mapPool(project.docFiles, EXTRACT_CONCURRENCY, (file) =>
      extractDocFile(root, file, languages),
    ),
    mapPool(project.sourceFiles, EXTRACT_CONCURRENCY, (file) =>
      extractSourceFile(root, file, languages),
    ),
  ]);
  return assembleDocumentationSet(root, [...docParts, ...sourceParts]);
}
