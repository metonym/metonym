import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  normalizeAbs,
  resolveInternal,
  toProjectRelative,
} from "../src/graph/paths";

describe("toProjectRelative", () => {
  test("relative path (./a/b.ts) resolves against root", () => {
    expect(toProjectRelative("/repo", "./a/b.ts")).toBe("a/b.ts");
  });

  test("absolute path inside root", () => {
    expect(toProjectRelative("/repo", "/repo/src/index.ts")).toBe(
      "src/index.ts",
    );
  });

  test("absolute path outside root keeps ../ segments", () => {
    expect(
      toProjectRelative("/repo/packages/foo", "/repo/packages/bar/x.ts"),
    ).toBe("../bar/x.ts");
  });

  test("strips macOS /private prefix from both root and path", () => {
    expect(
      toProjectRelative(
        "/private/var/folders/x/repo",
        "/var/folders/x/repo/a.ts",
      ),
    ).toBe("a.ts");
  });
});

describe("normalizeAbs", () => {
  test("strips /private prefix", () => {
    expect(normalizeAbs("/private/tmp/x")).toBe("/tmp/x");
  });

  test("leaves non-/private paths untouched", () => {
    expect(normalizeAbs("/tmp/x")).toBe("/tmp/x");
  });
});

describe("resolveInternal", () => {
  test("returns null for a bun: builtin", () => {
    const root = mkdtempSync(join(tmpdir(), "paths-test-"));
    try {
      expect(resolveInternal(root, "bun:test", root)).toBeNull();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("returns null for a node_modules package", async () => {
    const root = mkdtempSync(join(tmpdir(), "paths-test-"));
    try {
      await Bun.write(
        join(root, "node_modules/some-pkg/package.json"),
        JSON.stringify({ name: "some-pkg", main: "index.js" }),
      );
      await Bun.write(join(root, "node_modules/some-pkg/index.js"), "");
      expect(resolveInternal(root, "some-pkg", root)).toBeNull();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("returns a project-relative path for a relative import", async () => {
    const root = mkdtempSync(join(tmpdir(), "paths-test-"));
    try {
      await Bun.write(join(root, "src/util.ts"), "export const x = 1;\n");
      expect(resolveInternal(root, "./util", join(root, "src"))).toBe(
        "src/util.ts",
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
