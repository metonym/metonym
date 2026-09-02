/**
 * Extraction cache.
 *
 * One index file holding every cached FilePart, keyed by repo-relative path
 * and validated by (mtime, size) when safe, else by contentKey(file text).
 * The whole index is scoped by configKey + versionKey: a different config
 * or tool version means an empty cache, not a partially stale one.
 *
 * Why one file, not one per source: extraction is cheap (tens of µs per
 * file), so a per-file cache spent more on the filesystem than it saved.
 * On a 2000-file repo the cold write of 2000 entries cost ~140ms and a
 * warm read of 2000 entries barely beat re-extracting. One read and one
 * atomic write amortise to nothing, and entries for files that left the
 * project simply drop out on the next write.
 */

import * as fs from "node:fs/promises";
import {
  assembleDocumentationSet,
  EXTRACT_CONCURRENCY,
  extractDocFile,
  extractSourceFile,
  type FilePart,
  mapPool,
} from "../extract.ts";
import type { DocumentationSet, Project } from "../ir/types.ts";
import { configKey, contentKey, versionKey } from "./keys.ts";

const INDEX_FILE = "index.json";

/**
 * A file whose mtime is at least this old is trusted on (mtime, size)
 * alone; anything newer is re-read and hashed. Same guard as git's index:
 * an edit within the mtime granularity of a coarse filesystem could
 * otherwise keep the old size and mtime and be missed. stat is ~10x
 * cheaper than read + hash, so the warm path mostly never opens sources.
 */
const RACY_WINDOW_MS = 2000;

interface IndexEntry {
  /** contentKey of the source text this part was extracted from. */
  key: string;
  mtimeMs: number;
  size: number;
  part: FilePart;
}

interface IndexFile {
  version: 2;
  /** `${configKey}:${versionKey}` the entries were produced under. */
  scope: string;
  entries: Record<string, IndexEntry>;
}

/**
 * Extract documentation with per-file caching.
 * Cache path: ${root}/.metonym/cache/extract/index.json
 */
export async function extractCached(
  project: Project,
): Promise<DocumentationSet> {
  return (await extractCachedWithKeys(project)).docs;
}

/**
 * extractCached plus the contentKey of every file it validated, keyed by
 * repo-relative path. Later cache layers (deep analysis) key on the same
 * hashes, and this saves them re-reading every source to recompute them.
 */
export async function extractCachedWithKeys(project: Project): Promise<{
  docs: DocumentationSet;
  fileKeys: Map<string, string>;
}> {
  const { root } = project;
  const languages = project.config.languages;
  const cacheDir = `${root}/.metonym/cache/extract`;
  const indexPath = `${cacheDir}/${INDEX_FILE}`;
  const scope = `${configKey(project.config)}:${versionKey()}`;

  const previous = await readIndex(indexPath, scope);
  const next = new Map<string, IndexEntry>();
  const trustBefore = Date.now() - RACY_WINDOW_MS;
  let dirty = 0;

  const extractOne = async (
    file: string,
    isDocFile: boolean,
  ): Promise<FilePart> => {
    const source = Bun.file(`${root}/${file}`);
    const hit = previous[file];
    const valid = hit !== undefined && hit.part?.file === file;

    let mtimeMs = 0;
    let size = 0;
    try {
      const st = await source.stat();
      mtimeMs = st.mtimeMs;
      size = st.size;
    } catch {
      // Unreadable metadata: fall through to the content path.
    }

    if (
      valid &&
      hit.mtimeMs === mtimeMs &&
      hit.size === size &&
      mtimeMs < trustBefore
    ) {
      next.set(file, hit);
      return hit.part;
    }

    const text = await source.text();
    const key = contentKey(text);

    if (valid && hit.key === key) {
      // Same content, drifted metadata (touch, checkout). Refresh so the
      // next run takes the stat path.
      next.set(file, { ...hit, mtimeMs, size });
      dirty++;
      return hit.part;
    }

    const part = isDocFile
      ? await extractDocFile(root, file, languages, text)
      : await extractSourceFile(root, file, languages, text);
    next.set(file, { key, mtimeMs, size, part });
    dirty++;
    return part;
  };

  const [docParts, sourceParts] = await Promise.all([
    mapPool(project.docFiles, EXTRACT_CONCURRENCY, (file) =>
      extractOne(file, true),
    ),
    mapPool(project.sourceFiles, EXTRACT_CONCURRENCY, (file) =>
      extractOne(file, false),
    ),
  ]);

  // Rewrite when any entry changed or files left the project (their
  // entries are absent from `next`). A pure hit run writes nothing.
  const staleCount = Object.keys(previous).length - next.size;
  if (dirty > 0 || staleCount !== 0) {
    await writeIndex(cacheDir, indexPath, scope, next);
  }

  const fileKeys = new Map<string, string>();
  for (const [file, entry] of next) fileKeys.set(file, entry.key);

  return {
    docs: assembleDocumentationSet(root, [...docParts, ...sourceParts]),
    fileKeys,
  };
}

/** Entries from disk, or none if missing, corrupt, or from another scope. */
async function readIndex(
  indexPath: string,
  scope: string,
): Promise<Record<string, IndexEntry>> {
  try {
    const parsed = JSON.parse(await Bun.file(indexPath).text()) as IndexFile;
    if (
      parsed.version === 2 &&
      parsed.scope === scope &&
      typeof parsed.entries === "object" &&
      parsed.entries !== null
    ) {
      return parsed.entries;
    }
  } catch {
    // Missing or invalid cache is the same as an empty one.
  }
  return {};
}

async function writeIndex(
  cacheDir: string,
  indexPath: string,
  scope: string,
  entries: Map<string, IndexEntry>,
): Promise<void> {
  // Sorted so the same project state always serialises to the same bytes.
  const ordered: Record<string, IndexEntry> = {};
  for (const file of Array.from(entries.keys()).sort()) {
    ordered[file] = entries.get(file) as IndexEntry;
  }
  const index: IndexFile = { version: 2, scope, entries: ordered };

  await fs.mkdir(cacheDir, { recursive: true });
  const tempPath = `${indexPath}.tmp`;
  await fs.writeFile(tempPath, JSON.stringify(index), "utf-8");
  await fs.rename(tempPath, indexPath);
}

/**
 * Clear the entire extraction cache.
 */
export async function clearCache(root: string): Promise<void> {
  const cacheDir = `${root}/.metonym/cache`;
  try {
    await fs.rm(cacheDir, { recursive: true, force: true });
  } catch {
    // Ignore errors if cache dir doesn't exist
  }
}
