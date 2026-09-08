/**
 * Bun workspace package discovery, for `check --workspaces`.
 */

/**
 * Reads `<root>/package.json#workspaces` and expands its globs to
 * root-relative package directories (sorted). A directory only counts as a
 * package if it contains its own `package.json`. Returns `[]` when the root
 * has no `package.json`, no `workspaces` field, or the field matches nothing.
 */
export async function discoverWorkspaces(root: string): Promise<string[]> {
  const text = await Bun.file(`${root}/package.json`)
    .text()
    .catch(() => undefined);
  if (text === undefined) return [];

  let pkg: unknown;
  try {
    pkg = JSON.parse(text);
  } catch {
    return [];
  }

  const globs = workspaceGlobs(pkg);
  if (globs.length === 0) return [];

  const dirs = new Set<string>();
  for (const pattern of globs) {
    const glob = new Bun.Glob(pattern);
    for await (const entry of glob.scan({
      cwd: root,
      onlyFiles: false,
      dot: false,
    })) {
      const dir = entry.replace(/\\/g, "/").replace(/\/$/, "");
      if (dir.split("/").includes("node_modules")) continue;
      if (await Bun.file(`${root}/${dir}/package.json`).exists()) {
        dirs.add(dir);
      }
    }
  }

  return Array.from(dirs).sort();
}

function workspaceGlobs(pkg: unknown): string[] {
  if (typeof pkg !== "object" || pkg === null) return [];
  const workspaces = (pkg as Record<string, unknown>).workspaces;
  if (Array.isArray(workspaces)) {
    return workspaces.filter((g): g is string => typeof g === "string");
  }
  if (typeof workspaces === "object" && workspaces !== null) {
    const packages = (workspaces as Record<string, unknown>).packages;
    if (Array.isArray(packages)) {
      return packages.filter((g): g is string => typeof g === "string");
    }
  }
  return [];
}
