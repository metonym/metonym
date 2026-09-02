/**
 * Result cache.
 * Caches passing test results by example id + import closure hash + version.
 * Failures are never cached. Cache is advisory; corruption is tolerated.
 */

import * as fs from "node:fs/promises";
import { exampleImports } from "../extract.ts";
import type {
  DocumentationSet,
  Example,
  ExampleResult,
  RunResult,
} from "../ir/types.ts";
import {
  type ClosureFileCache,
  closureKey,
  createClosureFileCache,
  versionKey,
} from "./keys.ts";

interface CachedEntry {
  status: "passed";
  durationMs: number;
  at: string; // ISO timestamp
}

interface ResultsFile {
  version: 1;
  entries: Record<string, CachedEntry>;
}

/**
 * Run tests with result caching.
 * opts.full === true bypasses all cache reads (but still updates cache after).
 */
export async function runCached(
  docs: DocumentationSet,
  opts?: {
    outDir?: string;
    full?: boolean;
    /** Forwarded to generate() for the uncached subset (e.g. jsxImportSource). */
    emit?: { jsxImportSource?: string };
  },
): Promise<RunResult> {
  const root = docs.root;
  const resultsCachePath = `${root}/.metonym/cache/results.json`;
  const outDir = opts?.outDir ?? `${root}/.metonym/tests`;
  const fullRun = opts?.full ?? false;
  const vKey = versionKey();

  // Load results cache (tolerate absence/corruption)
  let resultsCache: ResultsFile = { version: 1, entries: {} };
  if (!fullRun) {
    try {
      const cached = await Bun.file(resultsCachePath).text();
      const parsed = JSON.parse(cached);
      if (parsed.version === 1 && typeof parsed.entries === "object") {
        resultsCache = parsed;
      }
    } catch {}
  }

  const cacheableExamples = docs.examples.filter(
    (ex) => ex.kind === "assertion" || ex.kind === "throws",
  );

  const cachedResults = new Map<string, ExampleResult>();
  const cacheKeyById = new Map<string, string>();
  const closureFiles = createClosureFileCache();

  if (!fullRun) {
    const keyed = await Promise.all(
      cacheableExamples.map(async (example) => ({
        example,
        cacheKey: await cacheKeyForExample(root, example, vKey, closureFiles),
      })),
    );
    for (const { example, cacheKey } of keyed) {
      cacheKeyById.set(example.id, cacheKey);
      const cached = resultsCache.entries[cacheKey];

      if (cached && cached.status === "passed") {
        cachedResults.set(example.id, {
          exampleId: example.id,
          title: example.title,
          docFile: example.source.file,
          status: "passed",
          durationMs: cached.durationMs,
          fromCache: true,
        });
      }
    }
  }

  const uncachedExampleIds = new Set(
    cacheableExamples
      .filter((ex) => !cachedResults.has(ex.id))
      .map((ex) => ex.id),
  );

  const filteredExamples = docs.examples.filter(
    (ex) =>
      !cachedResults.has(ex.id) ||
      (ex.kind !== "assertion" && ex.kind !== "throws"),
  );

  const filteredDocs: DocumentationSet = {
    ...docs,
    examples: filteredExamples,
    documents: docs.documents.map((doc) => ({
      ...doc,
      exampleIds: doc.exampleIds.filter(
        (id) => !cachedResults.has(id) || uncachedExampleIds.has(id),
      ),
    })),
  };

  filteredDocs.documents = filteredDocs.documents.filter(
    (doc) => doc.exampleIds.length > 0,
  );

  let freshResults: RunResult;
  if (filteredExamples.length === 0) {
    freshResults = {
      results: [],
      totals: {
        total: 0,
        passed: 0,
        failed: 0,
        pending: 0,
        skipped: 0,
        durationMs: 0,
      },
      outDir,
      exitCode: 0,
    };
  } else {
    const { run } = await import("../run/run.ts");
    const { generate } = await import("../emit/generate.ts");

    const filteredGenerated = generate(filteredDocs, opts?.emit);
    freshResults = await run(filteredDocs, {
      generated: filteredGenerated,
      outDir,
    });
  }

  const allResults: ExampleResult[] = [
    ...freshResults.results,
    ...Array.from(cachedResults.values()),
  ];

  const lineMap = new Map<string, number>();
  for (const ex of docs.examples) {
    lineMap.set(ex.id, ex.source.start.line);
  }

  allResults.sort((a, b) => {
    if (a.docFile !== b.docFile) {
      return a.docFile.localeCompare(b.docFile);
    }
    const lineA = lineMap.get(a.exampleId) ?? 0;
    const lineB = lineMap.get(b.exampleId) ?? 0;
    return lineA - lineB;
  });

  const totals = {
    total: allResults.length,
    passed: allResults.filter((r) => r.status === "passed").length,
    failed: allResults.filter((r) => r.status === "failed").length,
    pending: allResults.filter((r) => r.status === "pending").length,
    skipped: allResults.filter((r) => r.status === "skipped").length,
    durationMs: freshResults.totals.durationMs,
    cached: cachedResults.size,
  };

  const now = new Date().toISOString();
  const updatedEntries = { ...resultsCache.entries };
  let cacheDirty = false;
  const examplesById = new Map(docs.examples.map((ex) => [ex.id, ex]));

  for (const result of freshResults.results) {
    if (result.status === "passed") {
      const example = examplesById.get(result.exampleId);
      if (example) {
        const cacheKey =
          cacheKeyById.get(example.id) ??
          (await cacheKeyForExample(root, example, vKey, closureFiles));
        updatedEntries[cacheKey] = {
          status: "passed",
          durationMs: result.durationMs ?? 0,
          at: now,
        };
        cacheDirty = true;
      }
    }
  }

  const thirtyDaysAgo = Date.now() - 30 * 24 * 60 * 60 * 1000;
  for (const [key, entry] of Object.entries(updatedEntries)) {
    if (Date.parse(entry.at) < thirtyDaysAgo) {
      delete updatedEntries[key];
      cacheDirty = true;
    }
  }

  if (cacheDirty) {
    const resultsCacheDir = `${root}/.metonym/cache`;
    await fs.mkdir(resultsCacheDir, { recursive: true });
    const tempPath = `${resultsCachePath}.tmp`;
    await fs.writeFile(
      tempPath,
      JSON.stringify({
        version: 1,
        entries: updatedEntries,
      } satisfies ResultsFile),
      "utf-8",
    );
    await fs.rename(tempPath, resultsCachePath);
  }

  return {
    results: allResults,
    totals,
    outDir,
    exitCode: freshResults.exitCode,
  };
}

/**
 * Build cache key for an example:
 * ${example.id}:${closureKey}:${versionKey}
 */
async function cacheKeyForExample(
  root: string,
  example: Example,
  vKey: string,
  closureFiles: ClosureFileCache,
): Promise<string> {
  const imports = exampleImports(example.code, example.language);

  if (imports.length === 0) {
    return `${example.id}::${vKey}`;
  }

  const resolvedFiles: string[] = [];

  for (const spec of imports) {
    try {
      const resolved = Bun.resolveSync(spec, root);

      // Only follow paths inside root (not bun:test, external packages)
      if (resolved.startsWith(root)) {
        if (!resolved.includes("/node_modules/")) {
          const relPath = resolved.slice(root.length + 1);
          resolvedFiles.push(relPath);
        }
      }
    } catch {}
  }

  const cKey =
    resolvedFiles.length > 0
      ? await closureKey(root, resolvedFiles, closureFiles)
      : "";

  return `${example.id}:${cKey}:${vKey}`;
}
