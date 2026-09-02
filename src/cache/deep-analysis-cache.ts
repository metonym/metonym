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
import type { DocumentationSet } from "../ir/types.ts";
import { contentKey, versionKey } from "./keys.ts";

async function deepAnalysisKey(
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

  return contentKey(
    [
      versionKey(),
      tsPath,
      contentKey(tsconfigText),
      fileHashes.sort().join("\n"),
      exampleIds.join("\n"),
    ].join("|"),
  );
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

  try {
    const cached = await Bun.file(cachePath).text();
    return JSON.parse(cached) as {
      docs: DocumentationSet;
      diagnostics: string[];
    };
  } catch {
    // Missing or corrupt entry — fall through and recompute.
  }

  const { enrichWithTypeScript } = await import("../analysis/ts-provider.ts");
  const result = await enrichWithTypeScript(docs, { tsPath, sourceFiles });

  await fs.mkdir(cacheDir, { recursive: true });
  const tempPath = `${cachePath}.tmp`;
  await fs.writeFile(tempPath, JSON.stringify(result), "utf-8");
  await fs.rename(tempPath, cachePath);
  await evictStale(cacheDir, key);

  return result;
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
