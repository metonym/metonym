/**
 * loadConfig: error propagation for a broken metonym.config.ts/.js or an
 * invalid package.json, and documented merge precedence.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { loadConfig } from "../src/config";

let root: string;

beforeEach(async () => {
  root = await mkdtemp(resolve(tmpdir(), "metonym-config-test-"));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("loadConfig", () => {
  test("syntax-error config rejects with a message naming the file", async () => {
    await writeFile(
      resolve(root, "metonym.config.ts"),
      "export default { include: [\n", // unbalanced brace/bracket
    );

    await expect(loadConfig(root)).rejects.toThrow("metonym.config.ts");
  });

  test("invalid package.json rejects", async () => {
    await writeFile(resolve(root, "package.json"), "{ not json");

    await expect(loadConfig(root)).rejects.toThrow(
      "package.json is not valid JSON",
    );
  });

  test("loads metonym.config.js when .ts is absent", async () => {
    await writeFile(
      resolve(root, "metonym.config.js"),
      "export default { outDir: 'from-js' };\n",
    );

    const config = await loadConfig(root);
    expect(config.outDir).toBe("from-js");
  });

  test("config file wins over package.json#metonym in documented precedence", async () => {
    await writeFile(
      resolve(root, "package.json"),
      JSON.stringify({ metonym: { outDir: "from-package-json" } }),
    );
    await writeFile(
      resolve(root, "metonym.config.ts"),
      "export default { outDir: 'from-config-file' };\n",
    );

    const config = await loadConfig(root);
    expect(config.outDir).toBe("from-config-file");
  });
});
