import { resolve } from "node:path";
import { loadConfig } from "../config.ts";
import type { MetonymConfig, Project } from "../ir/types.ts";

/**
 * Scan a project root for documentation and source files.
 *
 * Uses Bun.Glob to enumerate include patterns, filters via exclude patterns,
 * and classifies files into docFiles (.md/.markdown) and sourceFiles (.ts/.tsx/.js/.jsx/.mts/.cts/.mjs/.cjs).
 * Never includes files under the configured outDir.
 * Returns sorted lists (posix separators, repo-relative, no leading ./).
 */
export async function scan(opts?: {
  root?: string;
  config?: Partial<MetonymConfig>;
}): Promise<Project> {
  const root = opts?.root ? resolve(opts.root) : process.cwd();
  const config = await loadConfig(root, opts?.config);

  const docFiles: Set<string> = new Set();
  const sourceFiles: Set<string> = new Set();
  const excludeGlobs = config.exclude.map((pattern) => new Bun.Glob(pattern));
  const outDirPrefix = dirPrefix(config.outDir);

  for (const pattern of config.include) {
    const glob = new Bun.Glob(pattern);

    // Glob paths are already root-relative; normalizing is all resolve()
    // + relative() achieved, minus two path parses per file.
    for await (const file of glob.scan({
      cwd: root,
      onlyFiles: true,
      dot: false,
    })) {
      const relPath = normalizePath(file);

      if (
        relPath.startsWith(outDirPrefix) ||
        `${root}/${relPath}`.startsWith(outDirPrefix)
      ) {
        continue;
      }

      if (shouldExclude(file, relPath, excludeGlobs)) {
        continue;
      }

      const dot = relPath.lastIndexOf(".");
      if (dot === -1) continue;
      const ext = relPath.slice(dot + 1).toLowerCase();
      if (ext === "md" || ext === "markdown" || ext === "mdx") {
        docFiles.add(relPath);
      } else if (SOURCE_EXTS.has(ext)) {
        sourceFiles.add(relPath);
      }
    }
  }

  const sortedDocFiles = Array.from(docFiles).sort();
  const sortedSourceFiles = Array.from(sourceFiles).sort();

  return {
    root,
    config,
    docFiles: sortedDocFiles,
    sourceFiles: sortedSourceFiles,
  };
}

const SOURCE_EXTS = new Set([
  "ts",
  "tsx",
  "js",
  "jsx",
  "mts",
  "cts",
  "mjs",
  "cjs",
]);

/**
 * Check if a path should be excluded based on exclude patterns.
 * `raw` is the glob's own spelling (may use backslashes on Windows).
 */
function shouldExclude(
  raw: string,
  normalized: string,
  excludeGlobs: Bun.Glob[],
): boolean {
  const checkRaw = raw !== normalized;
  for (const glob of excludeGlobs) {
    if (glob.match(normalized) || (checkRaw && glob.match(raw))) {
      return true;
    }
  }
  return false;
}

/**
 * Normalize a path to posix separators and remove leading ./
 */
function normalizePath(path: string): string {
  const posix = path.includes("\\") ? path.replaceAll("\\", "/") : path;

  if (posix.startsWith("./")) {
    return posix.slice(2);
  }

  return posix;
}

/** Normalized directory with a trailing slash, for prefix matching. */
function dirPrefix(dir: string): string {
  const normalized = normalizePath(dir);
  return normalized.endsWith("/") ? normalized : `${normalized}/`;
}
