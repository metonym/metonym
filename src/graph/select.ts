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
 * 3. If no base ref could be determined and there are no changes (e.g. no
 *    origin/* and no --since) → mode "all" with note: the empty diff is
 *    ambiguous (no base to diff against), not evidence of "no changes"
 * 4. If a base was resolved and there are no changes → mode "affected"
 *    with empty filtered docs and an explicit note naming the base
 * 5. Otherwise → mode "affected" with filtered docs containing only affected examples
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
    if (!git.baseResolved) {
      return {
        docs,
        mode: "all",
        reasons: new Map(),
        note: "could not determine a git base ref — running all examples (pass --changed=<ref>)",
      };
    }

    const emptyDocs: DocumentationSet = {
      ...docs,
      examples: [],
      documents: docs.documents.map((d) => ({ ...d, exampleIds: [] })),
    };
    return {
      docs: emptyDocs,
      mode: "affected",
      reasons: new Map(),
      note: `no changes since ${git.base} — 0 examples selected`,
    };
  }

  const affected = await affectedExamples(docs, git.changedFiles, {
    topLevel: git.topLevel,
  });

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
