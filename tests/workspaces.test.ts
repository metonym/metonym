import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { discoverWorkspaces } from "../src/scan/workspaces";

describe("discoverWorkspaces", () => {
  let root: string;

  afterEach(async () => {
    if (root) await rm(root, { recursive: true, force: true });
  });

  test("array form expands globs to sorted package dirs", async () => {
    root = await mkdtemp(join(tmpdir(), "metonym-ws-array-"));
    await Bun.write(
      join(root, "package.json"),
      JSON.stringify({ workspaces: ["packages/*"] }),
    );
    await Bun.write(join(root, "packages/b/package.json"), "{}");
    await Bun.write(join(root, "packages/a/package.json"), "{}");

    expect(await discoverWorkspaces(root)).toEqual([
      "packages/a",
      "packages/b",
    ]);
  });

  test("object form ({ packages: [...] }) is also expanded", async () => {
    root = await mkdtemp(join(tmpdir(), "metonym-ws-object-"));
    await Bun.write(
      join(root, "package.json"),
      JSON.stringify({ workspaces: { packages: ["packages/*"] } }),
    );
    await Bun.write(join(root, "packages/a/package.json"), "{}");

    expect(await discoverWorkspaces(root)).toEqual(["packages/a"]);
  });

  test("a glob match without its own package.json is ignored", async () => {
    root = await mkdtemp(join(tmpdir(), "metonym-ws-nonpkg-"));
    await Bun.write(
      join(root, "package.json"),
      JSON.stringify({ workspaces: ["packages/*"] }),
    );
    await Bun.write(join(root, "packages/a/package.json"), "{}");
    await Bun.write(join(root, "packages/not-a-package/README.md"), "# hi\n");

    expect(await discoverWorkspaces(root)).toEqual(["packages/a"]);
  });

  test("no workspaces field returns []", async () => {
    root = await mkdtemp(join(tmpdir(), "metonym-ws-none-"));
    await Bun.write(join(root, "package.json"), JSON.stringify({}));

    expect(await discoverWorkspaces(root)).toEqual([]);
  });

  test("no package.json at all returns []", async () => {
    root = await mkdtemp(join(tmpdir(), "metonym-ws-nopkgjson-"));

    expect(await discoverWorkspaces(root)).toEqual([]);
  });
});
