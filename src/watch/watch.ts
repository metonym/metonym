import { watch } from "node:fs";
import { relative, resolve, sep } from "node:path";
import type { MetonymConfig } from "../ir/types";

export interface Watcher {
  stop(): void;
}

export function watchProject(opts: {
  root: string;
  config: MetonymConfig;
  onChange: (changedFiles: string[]) => void | Promise<void>;
  debounceMs?: number;
}): Watcher {
  const { root, config, onChange, debounceMs = 150 } = opts;

  let watcher: ReturnType<typeof watch> | null = null;
  let debounceTimer: ReturnType<typeof setTimeout> | null = null;
  let changedPaths: Set<string> = new Set();
  let isOnChangeRunning = false;
  let queuedPaths: Set<string> | null = null;
  let stopped = false;

  function normalizePath(filePath: string): string | null {
    try {
      const absPath = resolve(root, filePath);
      const rel = relative(root, absPath);
      return rel.split(sep).join("/");
    } catch {
      return null;
    }
  }

  function shouldFilter(relPath: string): boolean {
    const excludeDirs = [config.outDir, ".metonym/", "node_modules/", ".git/"];

    for (const dir of excludeDirs) {
      const normalized = dir.split(sep).join("/");
      if (
        relPath.startsWith(normalized) ||
        relPath.startsWith(`./${normalized}`)
      ) {
        return true;
      }
    }

    let matchesInclude = false;
    for (const pattern of config.include) {
      try {
        const glob = new Bun.Glob(pattern);
        if (glob.match(relPath)) {
          matchesInclude = true;
          break;
        }
      } catch {}
    }

    if (!matchesInclude) {
      return true;
    }

    for (const pattern of config.exclude) {
      try {
        const glob = new Bun.Glob(pattern);
        if (glob.match(relPath)) {
          return true;
        }
      } catch {}
    }

    return false;
  }

  async function processBatch(paths: Set<string>): Promise<void> {
    if (paths.size === 0) {
      return;
    }

    isOnChangeRunning = true;
    const sortedPaths = Array.from(paths).sort();

    try {
      await onChange(sortedPaths);
    } catch (err) {
      // Log but don't crash on onChange errors
      console.error("Error in watch onChange handler:", err);
    } finally {
      isOnChangeRunning = false;

      if (queuedPaths && queuedPaths.size > 0) {
        const nextPaths = queuedPaths;
        queuedPaths = null;
        await processBatch(nextPaths);
      }
    }
  }

  function scheduleProcess(): void {
    if (debounceTimer !== null) {
      clearTimeout(debounceTimer);
    }

    debounceTimer = setTimeout(async () => {
      debounceTimer = null;

      if (isOnChangeRunning) {
        // If onChange is still running, queue the paths for the next batch
        queuedPaths = new Set([...(queuedPaths || []), ...changedPaths]);
        changedPaths = new Set();
      } else {
        const toProcess = changedPaths;
        changedPaths = new Set();
        await processBatch(toProcess);
      }
    }, debounceMs);
  }

  try {
    watcher = watch(
      root,
      { recursive: true },
      (_eventType: string, filename: string | Buffer | null) => {
        if (stopped || !filename) {
          return;
        }

        const filePath =
          typeof filename === "string" ? filename : filename.toString();
        const normalized = normalizePath(filePath);

        if (!normalized || shouldFilter(normalized)) {
          return;
        }

        changedPaths.add(normalized);
        scheduleProcess();
      },
    );

    watcher.on("error", (err: NodeJS.ErrnoException) => {
      console.error("Watch error:", err);
      stop();
    });
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : String(err);
    throw new Error(
      `Failed to start recursive fs.watch (recursive watch may not be available on this platform): ${errorMsg}`,
    );
  }

  const stop = (): void => {
    if (stopped) {
      return;
    }

    stopped = true;

    if (debounceTimer !== null) {
      clearTimeout(debounceTimer);
      debounceTimer = null;
    }

    if (watcher) {
      watcher.close();
      watcher = null;
    }

    changedPaths.clear();
    queuedPaths = null;
  };

  return { stop };
}
