/**
 * Example → symbol reference analysis.
 * Detects which symbols from imported modules are actually used in example code.
 */

import type { DocumentationSet, Relation, SymbolInfo } from "../ir/types";
import { parseImportBindings } from "../parse/imports";
import { resolveInternal } from "./paths";

/**
 * Analyze all examples and emit reference relations for used symbols.
 * For each example:
 * 1. Parse import bindings
 * 2. Resolve module specifiers via Bun.resolveSync
 * 3. Match resolved files to symbols in the documentation set
 * 4. Check if bindings are actually used in code (word-boundary match)
 * 5. Handle re-exports (one-level hop)
 * 6. Emit deduped reference relations
 */
export function exampleReferences(docs: DocumentationSet): Relation[] {
  const relations: Relation[] = [];
  const seen = new Set<string>();

  for (const example of docs.examples) {
    const bindings = parseImportBindings(example.code);

    for (const binding of bindings) {
      const relPath = resolveInternal(docs.root, binding.specifier, docs.root);
      if (relPath === null) continue;

      let targetSymbol: SymbolInfo | undefined;

      if (binding.imported === "*") {
        const fileSymbols = docs.symbols.filter((s) => s.file === relPath);
        emitNamespaceReferences(
          example.id,
          binding.local,
          example.code,
          fileSymbols,
          relations,
          seen,
        );
        continue;
      }

      targetSymbol = docs.symbols.find(
        (s) => s.file === relPath && s.name === binding.imported,
      );

      if (!targetSymbol) {
        const namespaceExport = docs.symbols.find(
          (s) => s.file === relPath && s.name === "*" && s.reexportFrom,
        );

        if (namespaceExport?.reexportFrom) {
          const fileDir =
            relPath.substring(0, relPath.lastIndexOf("/") + 1) || "./";
          const reexportAbsPath = `${docs.root}/${fileDir}`;

          const hoppedRelPath = resolveInternal(
            docs.root,
            namespaceExport.reexportFrom,
            reexportAbsPath,
          );

          if (hoppedRelPath !== null) {
            targetSymbol = docs.symbols.find(
              (s) => s.file === hoppedRelPath && s.name === binding.imported,
            );
          }
        }
      }

      if (!targetSymbol) {
        continue;
      }

      if (!isBindingUsed(binding.local, example.code)) {
        continue;
      }

      const key = `${example.id}:${targetSymbol.id}`;
      if (!seen.has(key)) {
        seen.add(key);
        relations.push({
          kind: "references",
          from: example.id,
          to: targetSymbol.id,
        });
      }

      if (targetSymbol.reexportFrom) {
        const targetFileDir =
          targetSymbol.file.substring(
            0,
            targetSymbol.file.lastIndexOf("/") + 1,
          ) || "./";
        const targetAbsPath = `${docs.root}/${targetFileDir}`;

        const underlyingRelPath = resolveInternal(
          docs.root,
          targetSymbol.reexportFrom,
          targetAbsPath,
        );

        if (underlyingRelPath !== null) {
          const underlyingSymbol = docs.symbols.find(
            (s) => s.file === underlyingRelPath && s.name === binding.imported,
          );

          if (underlyingSymbol) {
            const underlyingKey = `${example.id}:${underlyingSymbol.id}`;
            if (!seen.has(underlyingKey)) {
              seen.add(underlyingKey);
              relations.push({
                kind: "references",
                from: example.id,
                to: underlyingSymbol.id,
              });
            }
          }
        }
      }
    }
  }

  relations.sort((a, b) => {
    if (a.from !== b.from) return a.from.localeCompare(b.from);
    return a.to.localeCompare(b.to);
  });

  return relations;
}

/**
 * For namespace imports (import * as ns), find all symbols in the file
 * that are actually used with ns.NAME pattern in the code.
 */
function emitNamespaceReferences(
  exampleId: string,
  nsLocal: string,
  code: string,
  fileSymbols: SymbolInfo[],
  relations: Relation[],
  seen: Set<string>,
): void {
  const codeWithoutImports = code
    .split("\n")
    .filter((line) => !line.trim().startsWith("import "))
    .join("\n");

  for (const symbol of fileSymbols) {
    if (symbol.name === "*") continue;

    const pattern = new RegExp(
      `\\b${escapeRegExp(nsLocal)}\\.${escapeRegExp(symbol.name)}\\b`,
    );
    if (!pattern.test(codeWithoutImports)) {
      continue;
    }

    const key = `${exampleId}:${symbol.id}`;
    if (!seen.has(key)) {
      seen.add(key);
      relations.push({
        kind: "references",
        from: exampleId,
        to: symbol.id,
      });
    }
  }
}

/**
 * Check if a binding is actually USED in the code beyond its import line.
 */
function isBindingUsed(local: string, code: string): boolean {
  // Remove import lines to avoid matching the binding in its own declaration
  const codeWithoutImports = code
    .split("\n")
    .filter((line) => !line.trim().startsWith("import "))
    .join("\n");

  const pattern = new RegExp(`\\b${escapeRegExp(local)}\\b`);
  return pattern.test(codeWithoutImports);
}

/**
 * Escape special regex characters in a string.
 */
function escapeRegExp(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * `references` relations for a documentation set: the ones already on
 * `docs.relations` (deep analysis), or computed on demand (shallow mode).
 * Single entry point so callers never duplicate the "if none, compute" check.
 */
export function ensureReferences(docs: DocumentationSet): Relation[] {
  const existing = docs.relations.filter((r) => r.kind === "references");
  if (existing.length > 0) return existing;
  return exampleReferences(docs);
}

/**
 * Get the set of symbol IDs referenced by at least one example.
 */
export function exercisedSymbols(docs: DocumentationSet): Set<string> {
  const refs = exampleReferences(docs);
  const symbols = new Set<string>();

  for (const rel of refs) {
    if (rel.kind === "references") {
      symbols.add(rel.to);
    }
  }

  return symbols;
}
