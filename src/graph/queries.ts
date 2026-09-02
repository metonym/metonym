import type {
  DocumentationSet,
  Example,
  MetonymConfig,
  SymbolInfo,
} from "../ir/types";
import { getTranspiler, loaderFromPath } from "../parse/transpiler";

function stripPrivatePrefix(p: string): string {
  return p.replace(/^\/private/, "");
}

export interface CoverageReport {
  symbols: {
    total: number;
    documented: number;
    withExamples: number;
  };
  documents: {
    total: number;
    withExamples: number;
  };
  /** Deep analysis only; both fields are 0 without type-checked examples. */
  examples: {
    total: number;
    withTypeErrors: number;
  };
  undocumented: SymbolInfo[];
  documentedWithoutExamples: SymbolInfo[];
  /** Sorted by (docFile, title); deep analysis only. */
  examplesWithTypeErrors: {
    id: string;
    title: string;
    docFile: string;
    errorCount: number;
  }[];
  reexports: number;
}

/**
 * Analyze documentation coverage: which symbols have docs/examples,
 * which documents have examples. Excludes re-exports from the denominator.
 */
export function coverage(docs: DocumentationSet): CoverageReport {
  const documentedSymbols = new Set<string>();
  const symbolsWithExamples = new Set<string>();

  for (const rel of docs.relations) {
    if (rel.kind === "documents") {
      documentedSymbols.add(rel.to);
    }
    if (rel.kind === "owns") {
      symbolsWithExamples.add(rel.from);
    }
  }

  const docsWithExamples = docs.documents.filter(
    (d) => d.exampleIds.length > 0,
  ).length;

  const isCounted = (ex: Example): boolean =>
    ex.kind !== "ignored" && ex.kind !== "pending";

  const countedExamples = docs.examples.filter(isCounted);
  const examplesWithTypeErrors = countedExamples
    .map((ex) => ({
      id: ex.id,
      title: ex.title,
      docFile: ex.source.file,
      errorCount:
        ex.diagnostics?.filter((d) => d.severity === "error").length ?? 0,
    }))
    .filter((e) => e.errorCount > 0)
    .sort(
      (a, b) =>
        a.docFile.localeCompare(b.docFile) || a.title.localeCompare(b.title),
    );

  const isReexport = (sym: SymbolInfo): boolean => {
    return sym.declKind === "reexport" || sym.name === "*";
  };

  const undocumented: SymbolInfo[] = [];
  const documentedWithoutExamples: SymbolInfo[] = [];
  let reexportCount = 0;
  let countedTotal = 0;
  let countedDocumented = 0;
  let countedWithExamples = 0;

  for (const sym of docs.symbols) {
    if (isReexport(sym)) {
      reexportCount++;
      continue;
    }

    countedTotal++;

    // "documents" relations are only created alongside "owns" (both gated
    // on the same owned-example check), so a symbol's own JSDoc prose is
    // what actually makes it "documented" independent of having an example.
    const isDocumented = documentedSymbols.has(sym.id) || !!sym.description;
    const hasExamples = symbolsWithExamples.has(sym.id);

    if (isDocumented) {
      countedDocumented++;
    } else {
      undocumented.push(sym);
    }

    if (hasExamples) {
      countedWithExamples++;
    } else if (isDocumented) {
      documentedWithoutExamples.push(sym);
    }
  }

  const sortByFileAndName = (a: SymbolInfo, b: SymbolInfo) =>
    a.file.localeCompare(b.file) || a.name.localeCompare(b.name);

  undocumented.sort(sortByFileAndName);
  documentedWithoutExamples.sort(sortByFileAndName);

  return {
    symbols: {
      total: countedTotal,
      documented: countedDocumented,
      withExamples: countedWithExamples,
    },
    documents: {
      total: docs.documents.length,
      withExamples: docsWithExamples,
    },
    examples: {
      total: countedExamples.length,
      withTypeErrors: examplesWithTypeErrors.length,
    },
    undocumented,
    documentedWithoutExamples,
    examplesWithTypeErrors,
    reexports: reexportCount,
  };
}

/**
 * Resolve the entry files that an example imports.
 * Uses Bun.resolveSync to resolve module specifiers to absolute paths,
 * then converts back to repo-relative paths.
 * Returns repo-relative posix paths, sorted and deduped.
 */
export function exampleEntryFiles(
  docs: DocumentationSet,
  example: Example,
): string[] {
  const imports: string[] = [];

  for (const rel of docs.relations) {
    if (rel.kind === "imports" && rel.from === example.id) {
      imports.push(rel.to);
    }
  }

  const resolved = new Set<string>();

  const normalizedRoot = stripPrivatePrefix(docs.root);

  for (const spec of imports) {
    try {
      const absPath = Bun.resolveSync(spec, docs.root);

      if (absPath.includes("/node_modules/")) continue;

      const normalizedPath = stripPrivatePrefix(absPath);

      if (!normalizedPath.startsWith(normalizedRoot)) continue;

      const relPath = normalizedPath.slice(normalizedRoot.length + 1);
      resolved.add(relPath);
    } catch {}
  }

  return Array.from(resolved).sort();
}

/**
 * Determine which examples are affected by a set of changed files.
 * Returns a map of exampleId → array of reasons (strings).
 *
 * Rules (in order):
 * 1. If any changed file is package.json, bunfig.toml, or matches
 *    /(^|\/)metonym\.config\.(ts|js)$/ → ALL examples affected
 * 2. Example's source.file in changedFiles → reason "documentation changed: <file>"
 * 3. For each example, compute closure; if any closure file changed → reason "imports <file> (changed)"
 */
export async function affectedExamples(
  docs: DocumentationSet,
  changedFiles: string[],
): Promise<Map<string, string[]>> {
  const result = new Map<string, string[]>();

  const configChanged = changedFiles.some((f) => {
    if (f === "package.json" || f === "bunfig.toml") return true;
    if (/(^|\/)metonym\.config\.(ts|js)$/.test(f)) return true;
    return false;
  });

  if (configChanged) {
    const configFile = changedFiles.find((f) => {
      if (f === "package.json" || f === "bunfig.toml") return true;
      if (/(^|\/)metonym\.config\.(ts|js)$/.test(f)) return true;
      return false;
    });
    if (configFile === undefined) return result;

    for (const ex of docs.examples) {
      result.set(ex.id, [`config changed: ${configFile}`]);
    }
    return result;
  }

  const changedSet = new Set(changedFiles);

  for (const ex of docs.examples) {
    if (changedSet.has(ex.source.file)) {
      result.set(ex.id, [`documentation changed: ${ex.source.file}`]);
    }
  }

  // Cache closures by entry-file-set to avoid recomputing
  const closureCache = new Map<string, Set<string>>();

  for (const ex of docs.examples) {
    if (result.has(ex.id)) continue;

    const entryFiles = exampleEntryFiles(docs, ex);
    if (entryFiles.length === 0) continue;

    const cacheKey = JSON.stringify(entryFiles);
    let closureSet: Set<string>;

    if (closureCache.has(cacheKey)) {
      const cached = closureCache.get(cacheKey);
      if (cached === undefined) continue;
      closureSet = cached;
    } else {
      const normalizedRoot = stripPrivatePrefix(docs.root);
      closureSet = new Set<string>();

      const visited = new Set<string>();
      const queue = [...entryFiles];

      while (queue.length > 0) {
        const relPath = queue.shift();
        if (relPath === undefined) break;
        if (visited.has(relPath)) continue;
        visited.add(relPath);

        closureSet.add(relPath);

        const fullPath = `${docs.root}/${relPath}`;
        let text: string;
        try {
          text = await Bun.file(fullPath).text();
        } catch {
          continue;
        }

        let imports: Array<{ path: string }>;
        try {
          imports = getTranspiler(loaderFromPath(relPath)).scanImports(text);
        } catch {
          continue;
        }

        const dirOfFile =
          relPath.substring(0, relPath.lastIndexOf("/") + 1) || "./";

        for (const imp of imports) {
          try {
            const resolved = Bun.resolveSync(
              imp.path,
              `${docs.root}/${dirOfFile}`,
            );
            const normalizedResolved = stripPrivatePrefix(resolved);

            if (!normalizedResolved.startsWith(normalizedRoot)) continue;
            if (normalizedResolved.includes("/node_modules/")) continue;

            const relResolved = normalizedResolved.slice(
              normalizedRoot.length + 1,
            );

            if (!visited.has(relResolved)) {
              queue.push(relResolved);
            }
          } catch {}
        }
      }

      closureCache.set(cacheKey, closureSet);
    }

    for (const relPath of closureSet) {
      if (changedSet.has(relPath)) {
        result.set(ex.id, [`imports ${relPath} (changed)`]);
        break;
      }
    }
  }

  return result;
}

/**
 * Result of checking documentation coverage against CI gates.
 */
export interface CoverageGateResult {
  pass: boolean;
  failures: string[];
  report: CoverageReport;
}

/**
 * Check documentation coverage against configured CI gates.
 * Returns structured result with pass/fail status and specific failure messages.
 *
 * Rules:
 * - minDocumented: percentage of symbols with documentation (documented/total*100)
 * - minExamples: percentage of symbols with executable examples (withExamples/total*100)
 * - failOnUndocumented: fail if any export lacks documentation entirely
 * - failOnTypeErrors: fail if any example has a type error (deep analysis only)
 *
 * When total symbols is 0, both percentage gates pass.
 */
export function checkCoverage(
  docs: DocumentationSet,
  gates: NonNullable<MetonymConfig["coverage"]>,
): CoverageGateResult {
  const report = coverage(docs);
  const failures: string[] = [];

  const total = report.symbols.total;

  const documentedPct =
    total > 0 ? (report.symbols.documented / total) * 100 : 100;
  const examplesPct =
    total > 0 ? (report.symbols.withExamples / total) * 100 : 100;

  if (gates.minDocumented !== undefined) {
    if (documentedPct < gates.minDocumented) {
      failures.push(
        `documented ${Math.round(documentedPct * 10) / 10}% < required ${gates.minDocumented}%`,
      );
    }
  }

  if (gates.minExamples !== undefined) {
    if (examplesPct < gates.minExamples) {
      failures.push(
        `examples ${Math.round(examplesPct * 10) / 10}% < required ${gates.minExamples}%`,
      );
    }
  }

  if (gates.failOnUndocumented) {
    if (report.undocumented.length > 0) {
      const undocList = report.undocumented
        .slice(0, 10)
        .map((s) => `${s.file} › ${s.name}`)
        .join(", ");
      const suffix =
        report.undocumented.length > 10
          ? `, …and ${report.undocumented.length - 10} more`
          : "";
      failures.push(`undocumented exports: ${undocList}${suffix}`);
    }
  }

  if (gates.failOnTypeErrors) {
    if (report.examplesWithTypeErrors.length > 0) {
      const errList = report.examplesWithTypeErrors
        .slice(0, 10)
        .map((e) => `${e.docFile} › ${e.title} (${e.errorCount})`)
        .join(", ");
      const suffix =
        report.examplesWithTypeErrors.length > 10
          ? `, …and ${report.examplesWithTypeErrors.length - 10} more`
          : "";
      failures.push(`type errors: ${errList}${suffix}`);
    }
  }

  return {
    pass: failures.length === 0,
    failures,
    report,
  };
}
