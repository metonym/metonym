/**
 * Shared cache filesystem helpers.
 */

import * as fs from "node:fs/promises";

/**
 * Write `contents` to `path` atomically: write to a temp file unique to
 * this process and call, then rename over the target. Unlike a fixed
 * `${path}.tmp`, concurrent writers never clobber each other's temp file;
 * the rename is still a last-write-wins overwrite of `path` itself. ENOENT
 * on rename is swallowed, since it means another writer's rename already
 * removed the cache directory this write was racing against (e.g.
 * `clearCache`).
 */
export async function writeAtomic(path: string, contents: string): Promise<void> {
  const tempPath = `${path}.${process.pid}.${Date.now().toString(36)}.tmp`;
  await fs.writeFile(tempPath, contents, "utf-8");
  try {
    await fs.rename(tempPath, path);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return;
    throw err;
  }
}
