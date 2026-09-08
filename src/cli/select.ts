/**
 * Example selection.
 * `filter` and `only` both narrow the example set; combined, they intersect.
 */

import type { DocumentationSet, Example } from "../ir/types";
import { UsageError } from "./usage-error";

export interface SelectOptions {
  /** Keep examples whose title contains this substring. */
  filter?: string;
  /**
   * Keep examples matching any of these entries. Each entry matches an
   * example id exactly, a prefix of it (e.g. `ex:README.md:44a5`), or
   * `<docFile>:<startLine>` (e.g. `README.md:18`). An entry that matches
   * nothing is a usage error, unless `strict` is false.
   */
  only?: string[];
  /**
   * When false, an `--only` entry matching nothing in this document set
   * yields zero examples instead of throwing. Used by `--workspaces`,
   * where one `--only` id is expected to match in exactly one package.
   */
  strict?: boolean;
}

function matchesOnly(example: Example, entry: string): boolean {
  if (example.id === entry || example.id.startsWith(entry)) return true;
  return `${example.source.file}:${example.source.start.line}` === entry;
}

/** Prunes `docs.examples` and `document.exampleIds` in place. */
export function selectExamples(
  docs: DocumentationSet,
  opts: SelectOptions,
): void {
  let keep: Set<string> | undefined;

  if (opts.only && opts.only.length > 0) {
    keep = new Set();
    for (const entry of opts.only) {
      const matches = docs.examples.filter((e) => matchesOnly(e, entry));
      if (matches.length === 0 && opts.strict !== false) {
        throw new UsageError(`no example matches --only=${entry}`);
      }
      for (const m of matches) keep.add(m.id);
    }
  }

  if (opts.filter) {
    const filterMatches = new Set(
      docs.examples
        .filter((e) => e.title.includes(opts.filter as string))
        .map((e) => e.id),
    );
    keep = keep
      ? new Set([...keep].filter((id) => filterMatches.has(id)))
      : filterMatches;
  }

  if (!keep) return;
  const kept = keep;
  docs.examples = docs.examples.filter((e) => kept.has(e.id));
  for (const d of docs.documents) {
    d.exampleIds = d.exampleIds.filter((id) => kept.has(id));
  }
}
