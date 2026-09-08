/**
 * Shared path helpers for the graph module: resolving module specifiers and
 * git output to project-root-relative posix paths.
 */

import { relative as pathRelative, resolve as pathResolve } from "node:path";

/** Strip the macOS `/private` prefix Bun.resolveSync/realpath add, and use posix separators. */
export function normalizeAbs(p: string): string {
  return p
    .replace(/^\/private(?=\/)/, "")
    .split("\\")
    .join("/");
}

/**
 * Convert an absolute or root-relative path to a path relative to `root`.
 * Relative input is resolved against `root`. Paths outside `root` keep
 * their `../` segments rather than being dropped.
 */
export function toProjectRelative(root: string, p: string): string {
  const normalizedRoot = normalizeAbs(root);
  const normalizedP = normalizeAbs(p);
  const abs = pathResolve(normalizedRoot, normalizedP);
  const rel = pathRelative(normalizedRoot, abs).split("\\").join("/");
  return rel === "" ? "." : rel;
}

/**
 * Resolve a module specifier from `fromDir` and classify it as internal to
 * the project. Returns `null` for node_modules packages and for anything
 * outside both `root` and `opts.topLevel` (the git top-level, when the
 * caller is admitting sibling-workspace files). Otherwise returns a path
 * relative to `root` (which may start with `../` for sibling packages).
 */
export function resolveInternal(
  root: string,
  spec: string,
  fromDir: string,
  opts?: { topLevel?: string },
): string | null {
  let absPath: string;
  try {
    absPath = Bun.resolveSync(spec, fromDir);
  } catch {
    return null;
  }

  const normalized = normalizeAbs(absPath);
  if (normalized.includes("/node_modules/")) return null;

  const normalizedRoot = normalizeAbs(root);
  const insideRoot =
    normalized === normalizedRoot ||
    normalized.startsWith(`${normalizedRoot}/`);

  let insideTopLevel = false;
  if (opts?.topLevel) {
    const normalizedTopLevel = normalizeAbs(opts.topLevel);
    insideTopLevel =
      normalized === normalizedTopLevel ||
      normalized.startsWith(`${normalizedTopLevel}/`);
  }

  if (!insideRoot && !insideTopLevel) return null;

  return toProjectRelative(root, normalized);
}
