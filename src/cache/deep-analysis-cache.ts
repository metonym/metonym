/**
 * Deep-analysis (TypeScript compiler) cache.
 *
 * enrichWithTypeScript builds one ts.createProgram covering every source
 * and example file — a whole-program operation, so unlike extraction
 * there's no useful per-file cache: either nothing relevant changed and we
 * skip it entirely, or something did and the whole thing reruns once.
 *
 * The cached output is enrichment metadata only (hovers, diagnostics,
 * signatures, references/calls relations) — never anything run() uses to
 * decide pass/fail — so a same-key hit is safe to trust, and a missing or
 * corrupt entry just falls through and recomputes.
 */
import * as fs from "node:fs/promises";
import { dirname } from "node:path";
import type { DocumentationSet } from "../ir/types.ts";
import { contentKey, versionKey } from "./keys.ts";

/**
 * Read the version of the `typescript` package `tsPath` was loaded from,
 * without loading the compiler itself: walk up from `tsPath` looking for
 * the nearest `package.json` that identifies it as the `typescript`
 * package (by `name` or by directory name, since vendored/aliased
 * compilers like `@typescript/typescript6` don't use the `typescript`
 * package name). Falls back to `tsPath` (the caller's key material) when
 * no such `package.json` is found.
 */
async function resolveTsPackageVersion(tsPath: string): Promise<string | null> {
  let dir = dirname(tsPath);
  for (let i = 0; i < 8; i++) {
    try {
      const text = await Bun.file(`${dir}/package.json`).text();
      const pkg = JSON.parse(text) as { name?: string; version?: string };
      if (
        typeof pkg.version === "string" &&
        (pkg.name === "typescript" || dir.endsWith("/typescript"))
      ) {
        return pkg.version;
      }
    } catch {
      // No package.json here, or unreadable/invalid; keep walking up.
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

export async function deepAnalysisKey(
  docs: DocumentationSet,
  sourceFiles: string[],
  tsPath: string,
  fileKeys?: ReadonlyMap<string, string>,
): Promise<string> {
  // fileKeys are contentKey(text) as computed by the extract cache, so a
  // provided key is byte-for-byte what hashing the file here would give.
  const fileHashes = await Promise.all(
    sourceFiles.map(async (f) => {
      const known = fileKeys?.get(f);
      if (known !== undefined) return `${f}:${known}`;
      try {
        const text = await Bun.file(`${docs.root}/${f}`).text();
        return `${f}:${contentKey(text)}`;
      } catch {
        return `${f}:missing`;
      }
    }),
  );
  const exampleIds = docs.examples
    .filter((e) => e.kind !== "ignored" && e.kind !== "pending")
    .map((e) => e.id)
    .sort();
  const tsconfigText = await Bun.file(`${docs.root}/tsconfig.json`)
    .text()
    .catch(() => "");
  const tsVersion = (await resolveTsPackageVersion(tsPath)) ?? tsPath;

  return contentKey(
    [
      await versionKey(docs.root),
      `typescript@${tsVersion}`,
      contentKey(tsconfigText),
      fileHashes.sort().join("\n"),
      exampleIds.join("\n"),
    ].join("|"),
  );
}

interface DeepAnalysisEntry {
  docs: DocumentationSet;
  diagnostics: string[];
  /**
   * Repo-relative paths of every file ts.createProgram actually pulled in
   * from inside root (excluding node_modules), not just the scanned
   * `sourceFiles` the key was built from: local helpers reachable through
   * imports, .d.ts files, path-alias targets.
   * TODO: also include tsconfig.json files discovered via `extends` once
   * the provider exposes them; right now only the fixed tsconfig.json
   * path is part of the key.
   */
  programFiles: string[];
  /** Hash of programFiles' current content, recomputed on every lookup. */
  programFilesHash: string;
}

/** True when the last `enrichWithTypeScriptCached` call was a cache hit. Test-only. */
export let lastDeepAnalysisHit = false;

async function hashProgramFiles(
  root: string,
  files: readonly string[],
): Promise<string> {
  const hashes = await Promise.all(
    files.map(async (f) => {
      try {
        const text = await Bun.file(`${root}/${f}`).text();
        return `${f}:${contentKey(text)}`;
      } catch {
        return `${f}:missing`;
      }
    }),
  );
  return contentKey(hashes.sort().join("\n"));
}

export async function enrichWithTypeScriptCached(
  docs: DocumentationSet,
  opts?: {
    tsPath?: string;
    sourceFiles?: string[];
    /** contentKey per repo-relative source file, when the caller already has them. */
    fileKeys?: ReadonlyMap<string, string>;
  },
): Promise<{ docs: DocumentationSet; diagnostics: string[] }> {
  const tsPath = opts?.tsPath ?? Bun.resolveSync("typescript", docs.root);
  const sourceFiles = opts?.sourceFiles ?? [
    ...new Set(docs.symbols.map((s) => s.file)),
  ];

  const cacheDir = `${docs.root}/.metonym/cache/deep`;
  const key = await deepAnalysisKey(docs, sourceFiles, tsPath, opts?.fileKeys);
  const cachePath = `${cacheDir}/${key}.json`;

  lastDeepAnalysisHit = false;
  try {
    const cachedText = await Bun.file(cachePath).text();
    const cached = JSON.parse(cachedText) as DeepAnalysisEntry;
    if (
      Array.isArray(cached.programFiles) &&
      typeof cached.programFilesHash === "string"
    ) {
      const currentHash = await hashProgramFiles(
        docs.root,
        cached.programFiles,
      );
      if (currentHash === cached.programFilesHash) {
        lastDeepAnalysisHit = true;
        return { docs: cached.docs, diagnostics: cached.diagnostics };
      }
    }
  } catch {
    // Missing or corrupt entry — fall through and recompute.
  }

  const { enrichWithTypeScript } = await import("../analysis/ts-provider.ts");
  const result = await enrichWithTypeScript(docs, { tsPath, sourceFiles });
  const programFiles = result.programFiles ?? sourceFiles;
  const programFilesHash = await hashProgramFiles(docs.root, programFiles);
  const entry: DeepAnalysisEntry = {
    docs: result.docs,
    diagnostics: result.diagnostics,
    programFiles,
    programFilesHash,
  };

  await fs.mkdir(cacheDir, { recursive: true });
  const tempPath = `${cachePath}.tmp`;
  await fs.writeFile(tempPath, JSON.stringify(entry), "utf-8");
  await fs.rename(tempPath, cachePath);
  await evictStale(cacheDir, key);

  return { docs: entry.docs, diagnostics: entry.diagnostics };
}

/** Keep only the current project-state entry; old snapshots are dead weight. */
async function evictStale(cacheDir: string, keepKey: string): Promise<void> {
  try {
    const entries = await fs.readdir(cacheDir);
    const unlinks = entries
      .filter((e) => e !== `${keepKey}.json`)
      .map((e) =>
        fs.unlink(`${cacheDir}/${e}`).then(
          () => undefined,
          () => undefined,
        ),
      );
    if (unlinks.length > 0) await Promise.all(unlinks);
  } catch {
    // Ignore readdir errors (dir might not exist yet).
  }
}
