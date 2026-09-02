/**
 * Graph-aware test selection.
 * Determines which examples to run based on changed files.
 */

import type { DocumentationSet } from "../ir/types";
import { changedFiles as gitChangedFiles } from "./git";
import { affectedExamples } from "./queries";

export interface Selection {
  docs: DocumentationSet;
  mode: "all" | "affected";
  reasons: Map<string, string[]>; // exampleId → reasons
  note?: string;
}

/**
 * Select affected examples based on git changes.
 *
 * Strategy:
 * 1. Check git availability and collect changes
 * 2. If git unavailable → mode "all" with note
 * 3. If no changes → mode "affected" with empty filtered docs and note
 * 4. Otherwise → mode "affected" with filtered docs containing only affected examples
 */
export async function selectAffected(
  docs: DocumentationSet,
  opts?: { since?: string },
): Promise<Selection> {
  const git = gitChangedFiles(docs.root, opts?.since);

  if (!git.available) {
    return {
      docs,
      mode: "all",
      reasons: new Map(),
      note: "git unavailable — running all examples",
    };
  }

  if (git.changedFiles.length === 0) {
    const emptyDocs: DocumentationSet = {
      ...docs,
      examples: [],
      documents: docs.documents.map((d) => ({ ...d, exampleIds: [] })),
    };
    return {
      docs: emptyDocs,
      mode: "affected",
      reasons: new Map(),
      note: "no changes detected",
    };
  }

  const affected = await affectedExamples(docs, git.changedFiles);

  const affectedIds = new Set(affected.keys());
  const filteredExamples = docs.examples.filter((ex) => affectedIds.has(ex.id));

  const filteredDocuments = docs.documents.map((d) => ({
    ...d,
    exampleIds: d.exampleIds.filter((id) => affectedIds.has(id)),
  }));

  const baseRef = git.base ?? "working tree";
  const note = `${affectedIds.size}/${docs.examples.length} examples selected (base: ${baseRef})`;

  return {
    docs: {
      ...docs,
      examples: filteredExamples,
      documents: filteredDocuments,
    },
    mode: "affected",
    reasons: affected,
    note,
  };
}
