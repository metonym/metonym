/**
 * Impact analysis: determine which docs and examples are affected by changed files.
 */

import type { DocumentationSet } from "../ir/types";
import { getTranspiler, loaderFromPath } from "../parse/transpiler";
import type { GraphEdge, GraphNode } from "./emit";
import { exampleEntryFiles } from "./queries";

interface ImpactTrace {
  exampleId: string;
  docFile: string;
  title: string;
  changedFile: string;
  /** Import chain from the example's entry file to the changed file
   *  (inclusive both ends). Empty for doc/config-changed cases. */
  path: string[];
  reason: "imports" | "doc-changed" | "config-changed";
}

export interface Impact {
  changedFiles: string[];
  traces: ImpactTrace[];
  affectedExamples: string[]; // unique ids, sorted
  affectedDocs: string[]; // unique doc files, sorted
  /** exampleId → count of error-severity diagnostics, deep analysis only.
   *  Examples without type errors (or without deep analysis) are omitted. */
  typeErrorCounts: Record<string, number>;
}

/**
 * Compute impact of changed files on examples and docs.
 *
 * Rules:
 * 1. Config files changed (package.json, bunfig.toml, metonym.config.ts/js):
 *    one trace per example, reason "config-changed", path []
 * 2. Example's source.file in changedFiles: reason "doc-changed", path []
 * 3. Import impact: BFS from entry files, reconstruct path when changed file reached
 *
 * Traces sorted by (docFile, exampleId, changedFile).
 * affectedExamples/Docs deduped, sorted.
 */
export async function computeImpact(
  docs: DocumentationSet,
  changedFiles: string[],
): Promise<Impact> {
  const traces: ImpactTrace[] = [];
  const changedSet = new Set(changedFiles);

  // macOS /private prefix
  const normalizePath = (p: string) => p.replace(/^\/private/, "");
  const normalizedRoot = normalizePath(docs.root);

  async function getImportsForFile(file: string): Promise<string[]> {
    const fullPath = `${docs.root}/${file}`;
    let text: string;
    try {
      text = await Bun.file(fullPath).text();
    } catch {
      return [];
    }

    let imports: Array<{ path: string }>;
    try {
      imports = getTranspiler(loaderFromPath(file)).scanImports(text);
    } catch {
      return [];
    }

    const resolved = new Set<string>();
    const fileDir = file.substring(0, file.lastIndexOf("/") + 1) || "./";

    for (const imp of imports) {
      try {
        const absPath = Bun.resolveSync(imp.path, `${docs.root}/${fileDir}`);
        const normalized = normalizePath(absPath);

        if (!normalized.startsWith(normalizedRoot)) continue;
        if (normalized.includes("/node_modules/")) continue;

        const relPath = normalized.slice(normalizedRoot.length + 1);
        resolved.add(relPath);
      } catch {}
    }

    return Array.from(resolved);
  }

  async function findPath(
    entryFile: string,
    targetFile: string,
  ): Promise<string[] | null> {
    if (entryFile === targetFile) return [entryFile];

    const visited = new Set<string>();
    const parents = new Map<string, string>();
    const queue = [entryFile];
    visited.add(entryFile);

    while (queue.length > 0) {
      const current = queue.shift();
      if (current === undefined) break;

      if (current === targetFile) {
        const path: string[] = [current];
        let node = current;
        while (parents.has(node)) {
          const parent = parents.get(node);
          if (parent === undefined) break;
          node = parent;
          path.unshift(node);
        }
        return path;
      }

      const imports = await getImportsForFile(current);
      for (const next of imports) {
        if (visited.has(next)) continue;
        visited.add(next);
        parents.set(next, current);
        queue.push(next);
      }
    }

    return null;
  }

  const configRegex = /(^|\/)metonym\.config\.(ts|js)$/;
  const configChanged = changedFiles.find((f) => {
    if (f === "package.json" || f === "bunfig.toml") return true;
    if (configRegex.test(f)) return true;
    return false;
  });

  if (configChanged) {
    for (const example of docs.examples) {
      traces.push({
        exampleId: example.id,
        docFile: example.source.file,
        title: example.title,
        changedFile: configChanged,
        path: [],
        reason: "config-changed",
      });
    }
    return createImpact(docs, changedFiles, traces);
  }

  for (const example of docs.examples) {
    if (changedSet.has(example.source.file)) {
      traces.push({
        exampleId: example.id,
        docFile: example.source.file,
        title: example.title,
        changedFile: example.source.file,
        path: [],
        reason: "doc-changed",
      });
    }
  }

  const emittedPairs = new Set<string>();

  for (const example of docs.examples) {
    if (traces.some((t) => t.exampleId === example.id)) continue;

    const entryFiles = exampleEntryFiles(docs, example);
    if (entryFiles.length === 0) continue;

    for (const entryFile of entryFiles) {
      for (const changedFile of changedFiles) {
        if (
          changedSet.has(changedFile) &&
          docs.examples.some((e) => e.source.file === changedFile)
        ) {
          continue;
        }
        if (changedFile === "package.json" || changedFile === "bunfig.toml")
          continue;
        if (configRegex.test(changedFile)) continue;

        const path = await findPath(entryFile, changedFile);
        if (path) {
          const pairKey = `${example.id}:${changedFile}`;
          if (!emittedPairs.has(pairKey)) {
            emittedPairs.add(pairKey);
            traces.push({
              exampleId: example.id,
              docFile: example.source.file,
              title: example.title,
              changedFile,
              path,
              reason: "imports",
            });
          }
        }
      }
    }
  }

  return createImpact(docs, changedFiles, traces);
}

function createImpact(
  docs: DocumentationSet,
  changedFiles: string[],
  traces: ImpactTrace[],
): Impact {
  traces.sort((a, b) => {
    if (a.docFile !== b.docFile) return a.docFile.localeCompare(b.docFile);
    if (a.exampleId !== b.exampleId)
      return a.exampleId.localeCompare(b.exampleId);
    return a.changedFile.localeCompare(b.changedFile);
  });

  const exampleIds = new Set<string>();
  const docFiles = new Set<string>();

  for (const trace of traces) {
    exampleIds.add(trace.exampleId);
    docFiles.add(trace.docFile);
  }

  const typeErrorCounts: Record<string, number> = {};
  for (const id of exampleIds) {
    const example = docs.examples.find((e) => e.id === id);
    const errorCount =
      example?.diagnostics?.filter((d) => d.severity === "error").length ?? 0;
    if (errorCount > 0) typeErrorCounts[id] = errorCount;
  }

  return {
    changedFiles: [...changedFiles],
    traces,
    affectedExamples: Array.from(exampleIds).sort((a, b) => a.localeCompare(b)),
    affectedDocs: Array.from(docFiles).sort((a, b) => a.localeCompare(b)),
    typeErrorCounts,
  };
}

/**
 * Create a filtered subgraph showing impact paths.
 * Nodes: changed files (mod:), intermediate files (mod:), affected examples, affected docs.
 * Edges: path chains (reversed), entries to examples, examples to docs.
 */
export function impactGraph(
  docs: DocumentationSet,
  impact: Impact,
): { nodes: GraphNode[]; edges: GraphEdge[] } {
  const nodeMap = new Map<string, GraphNode>();
  const edgeSet = new Set<string>();
  const edges: GraphEdge[] = [];

  for (const file of impact.changedFiles) {
    const id = `mod:${file}`;
    nodeMap.set(id, {
      id,
      type: "module",
      label: `${file} (changed)`,
    });
  }

  for (const exampleId of impact.affectedExamples) {
    const example = docs.examples.find((e) => e.id === exampleId);
    if (example) {
      nodeMap.set(exampleId, {
        id: exampleId,
        type: "example",
        label: example.title,
      });
    }
  }

  for (const docId of impact.affectedDocs) {
    const doc = docs.documents.find(
      (d) => d.file === docId || d.id === `doc:${docId}`,
    );
    if (doc) {
      nodeMap.set(doc.id, {
        id: doc.id,
        type: "document",
        label: doc.file,
      });
    } else {
      const docNodeId = `doc:${docId}`;
      nodeMap.set(docNodeId, {
        id: docNodeId,
        type: "document",
        label: docId,
      });
    }
  }

  for (const trace of impact.traces) {
    if (trace.path.length === 0) {
      const changedId = `mod:${trace.changedFile}`;
      nodeMap.set(changedId, {
        id: changedId,
        type: "module",
        label: `${trace.changedFile} (changed)`,
      });

      const edgeKey = `${changedId}|${trace.exampleId}`;
      if (!edgeSet.has(edgeKey)) {
        edgeSet.add(edgeKey);
        edges.push({
          from: changedId,
          to: trace.exampleId,
          kind: "imports",
        });
      }
    } else {
      for (let i = 0; i < trace.path.length; i++) {
        const fileId = `mod:${trace.path[i]}`;
        if (!nodeMap.has(fileId)) {
          const isChanged = impact.changedFiles.includes(trace.path[i]);
          nodeMap.set(fileId, {
            id: fileId,
            type: "module",
            label: isChanged ? `${trace.path[i]} (changed)` : trace.path[i],
          });
        }
      }

      // Reversed: change flows toward the entry
      for (let i = 0; i < trace.path.length - 1; i++) {
        const fromId = `mod:${trace.path[i + 1]}`;
        const toId = `mod:${trace.path[i]}`;
        const edgeKey = `${fromId}|${toId}`;
        if (!edgeSet.has(edgeKey)) {
          edgeSet.add(edgeKey);
          edges.push({
            from: fromId,
            to: toId,
            kind: "imports",
          });
        }
      }

      const entryId = `mod:${trace.path[0]}`;
      const edgeKey = `${entryId}|${trace.exampleId}`;
      if (!edgeSet.has(edgeKey)) {
        edgeSet.add(edgeKey);
        edges.push({
          from: entryId,
          to: trace.exampleId,
          kind: "imports",
        });
      }
    }

    const example = docs.examples.find((e) => e.id === trace.exampleId);
    if (example) {
      const docNode = docs.documents.find((d) => d.id === example.documentId);
      if (docNode) {
        const edgeKey = `${trace.exampleId}|${docNode.id}`;
        if (!edgeSet.has(edgeKey)) {
          edgeSet.add(edgeKey);
          edges.push({
            from: trace.exampleId,
            to: docNode.id,
            kind: "contains",
          });
        }
      }
    }
  }

  const nodes = Array.from(nodeMap.values()).sort((a, b) =>
    a.id.localeCompare(b.id),
  );

  edges.sort((a, b) => {
    if (a.from !== b.from) return a.from.localeCompare(b.from);
    return a.to.localeCompare(b.to);
  });

  return { nodes, edges };
}

/**
 * Render impact as human-readable tree grouped by changed file.
 *
 * Format:
 * ```
 * src/util.ts changed
 *   → src/index.ts → 2 examples
 *       README.md › Quick start › example 1
 *       README.md › Quick start › example 2
 * docs/other.md changed (documentation)
 *   → docs/other.md › Intro › example 1
 *
 * 3 example(s) affected across 2 documentation file(s)
 * ```
 */
export function renderImpactTree(impact: Impact): string {
  const lines: string[] = [];
  const seenExamples = new Set<string>();

  const marker = (exampleId: string): string => {
    const count = impact.typeErrorCounts[exampleId];
    return count ? ` ⚠ ${count} type error(s)` : "";
  };

  const byChangedFile = new Map<string, ImpactTrace[]>();
  for (const trace of impact.traces) {
    if (!byChangedFile.has(trace.changedFile)) {
      byChangedFile.set(trace.changedFile, []);
    }
    byChangedFile.get(trace.changedFile)?.push(trace);
  }

  const sortedChangedFiles = Array.from(byChangedFile.keys()).sort();

  for (const changedFile of sortedChangedFiles) {
    const tracesForFile = byChangedFile
      .get(changedFile)
      ?.slice()
      .sort(
        (x, y) =>
          x.docFile.localeCompare(y.docFile) || x.title.localeCompare(y.title),
      );

    if (!tracesForFile || tracesForFile.length === 0) continue;

    if (tracesForFile[0].reason === "config-changed") {
      lines.push(`${changedFile} changed (config) — all examples affected`);

      if (impact.affectedExamples.length <= 20) {
        const byDocFile = new Map<string, ImpactTrace[]>();
        for (const trace of tracesForFile) {
          if (!byDocFile.has(trace.docFile)) {
            byDocFile.set(trace.docFile, []);
          }
          byDocFile.get(trace.docFile)?.push(trace);
        }

        for (const docFile of Array.from(byDocFile.keys()).sort()) {
          for (const trace of byDocFile.get(docFile) ?? []) {
            if (!seenExamples.has(trace.exampleId)) {
              seenExamples.add(trace.exampleId);
              lines.push(
                `  ${trace.docFile} › ${trace.title}${marker(trace.exampleId)}`,
              );
            }
          }
        }
      } else {
        lines.push(`  (${impact.affectedExamples.length} examples omitted)`);
      }
    } else if (tracesForFile[0].reason === "doc-changed") {
      lines.push(`${changedFile} changed (documentation)`);

      for (const trace of tracesForFile) {
        if (!seenExamples.has(trace.exampleId)) {
          seenExamples.add(trace.exampleId);
          lines.push(
            `  ${trace.docFile} › ${trace.title}${marker(trace.exampleId)}`,
          );
        }
      }
    } else {
      lines.push(`${changedFile} changed`);

      const byEntryFile = new Map<string, ImpactTrace[]>();
      for (const trace of tracesForFile) {
        const entry = trace.path[0] || trace.changedFile;
        if (!byEntryFile.has(entry)) {
          byEntryFile.set(entry, []);
        }
        byEntryFile.get(entry)?.push(trace);
      }

      for (const entry of Array.from(byEntryFile.keys()).sort()) {
        const tracesForEntry = byEntryFile.get(entry);
        if (!tracesForEntry) continue;

        const traceWithPath = tracesForEntry.find((t) => t.path.length > 0);
        let pathStr = "";
        if (traceWithPath && traceWithPath.path.length > 1) {
          // Skip entry; it's already in the "→ ${entry}" prefix
          const chainParts = traceWithPath.path.slice(1);
          pathStr = ` → ${chainParts.join(" → ")}`;
        }

        const examplesForEntry = new Set<string>();
        for (const trace of tracesForEntry) {
          examplesForEntry.add(trace.exampleId);
        }

        lines.push(
          `  → ${entry}${pathStr} → ${examplesForEntry.size} examples`,
        );

        for (const trace of tracesForEntry) {
          if (!seenExamples.has(trace.exampleId)) {
            seenExamples.add(trace.exampleId);
            lines.push(
              `      ${trace.docFile} › ${trace.title}${marker(trace.exampleId)}`,
            );
          }
        }
      }
    }

    lines.push("");
  }

  const exCount = impact.affectedExamples.length;
  const docCount = impact.affectedDocs.length;
  const typeErrorCount = Object.keys(impact.typeErrorCounts).length;
  const typeErrorSuffix = typeErrorCount
    ? `, ${typeErrorCount} with type errors`
    : "";
  lines.push(
    `${exCount} example(s) affected across ${docCount} documentation file(s)${typeErrorSuffix}`,
  );

  return `${lines.join("\n")}\n`;
}
