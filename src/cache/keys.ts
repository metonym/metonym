/**
 * Cache key generation.
 * All keys are content-addressable for stability and determinism.
 */

import type { MetonymConfig } from "../ir/types.ts";
import { TOOL_VERSION } from "../ir/types.ts";
import { getTranspiler, loaderFromPath } from "../parse/transpiler.ts";

/**
 * Compute xxHash64 of text, return as full 16-hex-char string.
 */
export function contentKey(text: string): string {
  return Bun.hash.xxHash64(text).toString(16).padStart(16, "0");
}

/**
 * Compute config key from [include, exclude, languages, inject].
 * Excludes root and outDir which don't affect extraction.
 */
export function configKey(config: MetonymConfig): string {
  const configData = [
    config.include,
    config.exclude,
    config.languages,
    config.inject,
  ];
  return contentKey(JSON.stringify(configData));
}

/**
 * Compute version key from tool version and Bun version.
 */
export function versionKey(): string {
  return `${TOOL_VERSION}:${Bun.version}`;
}

/**
 * Compute a stable hash of the local import closure from entry files.
 * BFS traversal: for each file, find imports via Bun.Transpiler.scanImports,
 * resolve them, follow only paths inside root and not under node_modules.
 * Result is a stable key that changes when any local dependency's content changes.
 */
export async function closureKey(
  root: string,
  entryRelFiles: string[],
  fileCache?: ClosureFileCache,
): Promise<string> {
  const hashes = await resolveClosure(root, entryRelFiles, fileCache);
  const sortedEntries = Array.from(hashes.entries())
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([relPath, hash]) => `${relPath}:${hash}`)
    .join("\n");
  return contentKey(sortedEntries);
}

/** What the closure walk learns about one file: its hash and resolved local imports. */
interface ClosureFileInfo {
  hash: string;
  /** Root-relative paths of local imports; empty when unreadable or unparseable. */
  localImports: string[];
}

/**
 * Per-run memo of file hashes and import edges. One `runCached` call asks
 * for the closure of every example that imports anything, and those
 * closures overlap heavily (most examples import the same few entry
 * points), so without this each file is re-read, re-hashed and re-scanned
 * once per example.
 */
export type ClosureFileCache = Map<string, Promise<ClosureFileInfo | null>>;

export function createClosureFileCache(): ClosureFileCache {
  return new Map();
}

async function closureFileInfo(
  root: string,
  relPath: string,
  fileCache: ClosureFileCache,
): Promise<ClosureFileInfo | null> {
  let pending = fileCache.get(relPath);
  if (!pending) {
    pending = loadClosureFileInfo(root, relPath);
    fileCache.set(relPath, pending);
  }
  return pending;
}

async function loadClosureFileInfo(
  root: string,
  relPath: string,
): Promise<ClosureFileInfo | null> {
  let text: string;
  try {
    text = await Bun.file(`${root}/${relPath}`).text();
  } catch {
    return null;
  }

  const hash = contentKey(text);
  const localImports: string[] = [];

  let imports: Array<{ path: string }>;
  try {
    imports = getTranspiler(loaderFromPath(relPath)).scanImports(text);
  } catch {
    return { hash, localImports };
  }

  const dirOfFile = relPath.substring(0, relPath.lastIndexOf("/") + 1) || "./";

  for (const imp of imports) {
    let resolved: string;
    try {
      resolved = Bun.resolveSync(imp.path, `${root}/${dirOfFile}`);
    } catch {
      // Import couldn't be resolved; skip it
      // (e.g., bun:test, external packages)
      continue;
    }

    if (!resolved.startsWith(root)) continue;

    if (resolved.includes("/node_modules/")) continue;

    localImports.push(resolved.slice(root.length + 1));
  }

  return { hash, localImports };
}

/**
 * The local import closure itself: relPath → contentKey for every file inside
 * root reachable from the entry files. Used for result-cache hashing; the
 * graph module (impact analysis / test selection) walks closures separately.
 */
async function resolveClosure(
  root: string,
  entryRelFiles: string[],
  fileCache: ClosureFileCache = createClosureFileCache(),
): Promise<Map<string, string>> {
  const visited = new Set<string>();
  const hashes = new Map<string, string>(); // relPath -> contentKey

  const queue = [...entryRelFiles];

  while (queue.length > 0) {
    const relPath = queue.shift();
    if (relPath === undefined) break;

    if (visited.has(relPath)) continue;
    visited.add(relPath);

    const info = await closureFileInfo(root, relPath, fileCache);
    if (!info) continue;

    hashes.set(relPath, info.hash);

    for (const relResolved of info.localImports) {
      if (!visited.has(relResolved)) {
        queue.push(relResolved);
      }
    }
  }

  return hashes;
}
