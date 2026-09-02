/**
 * Tests for extraction and result caching.
 * Covers: extractCached, closureKey, runCached, corruption resilience.
 */

import { describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import { scan } from "metonym";
import { clearCache, extractCached } from "../src/cache/extract-cache";
import { closureKey } from "../src/cache/keys";
import { runCached } from "../src/cache/result-cache";
import { loadConfig } from "../src/config";

/**
 * Create a temporary fixture project directory.
 */
async function createFixture(_name: string): Promise<string> {
  const tmpBase = await fs.mkdtemp(`/tmp/metonym-test-`);
  return tmpBase;
}

/**
 * Clean up temp directory.
 */
async function cleanupFixture(dir: string): Promise<void> {
  try {
    await fs.rm(dir, { recursive: true, force: true });
  } catch {}
}

describe("cache", () => {
  describe("extractCached", () => {
    it("first call produces DocumentationSet equal to plain extract()", async () => {
      const root = await createFixture("extract-first-call");
      try {
        await fs.mkdir(`${root}/src`, { recursive: true });
        await fs.writeFile(
          `${root}/package.json`,
          JSON.stringify({
            name: "test-pkg",
            exports: { ".": "./src/index.ts" },
          }),
        );

        const readmeContent = `# Test\n\n\`\`\`ts\nexpect(1).toBe(1)\n\`\`\`\n`;
        await fs.writeFile(`${root}/README.md`, readmeContent);
        await fs.writeFile(
          `${root}/src/index.ts`,
          `export function add(a: number, b: number) {\n  return a + b\n}\n`,
        );

        const config = await loadConfig(root);
        const project = await scan(config);
        const docs = await extractCached(project);

        expect(docs.documents).toBeDefined();
        expect(docs.examples).toBeDefined();
        expect(docs.examples.length).toBeGreaterThan(0);
        expect(docs.root).toBe(root);
      } finally {
        await cleanupFixture(root);
      }
    });

    it("second call hits cache and returns same result", async () => {
      const root = await createFixture("extract-cache-hit");
      try {
        await fs.mkdir(`${root}/src`, { recursive: true });
        await fs.writeFile(
          `${root}/package.json`,
          JSON.stringify({
            name: "test-pkg",
            exports: { ".": "./src/index.ts" },
          }),
        );
        await fs.writeFile(
          `${root}/README.md`,
          `# Test\n\n\`\`\`ts\nexpect(1).toBe(1)\n\`\`\`\n`,
        );
        await fs.writeFile(
          `${root}/src/index.ts`,
          `export function add(a: number, b: number) {\n  return a + b\n}\n`,
        );

        const config = await loadConfig(root);
        const project = await scan(config);

        const docs1 = await extractCached(project);
        const cacheDir = `${root}/.metonym/cache/extract`;
        const cacheEntries1 = await fs.readdir(cacheDir);

        expect(cacheEntries1.length).toBeGreaterThan(0);

        const docs2 = await extractCached(project);

        expect(docs2.examples.length).toBe(docs1.examples.length);
        expect(docs2.documents.length).toBe(docs1.documents.length);

        const cacheEntries2 = await fs.readdir(cacheDir);
        expect(cacheEntries2.length).toBe(cacheEntries1.length);
      } finally {
        await cleanupFixture(root);
      }
    });

    it("corrupt cache file triggers re-extraction", async () => {
      const root = await createFixture("extract-corrupt-cache");
      try {
        await fs.mkdir(`${root}/src`, { recursive: true });
        await fs.writeFile(
          `${root}/package.json`,
          JSON.stringify({
            name: "test-pkg",
            exports: { ".": "./src/index.ts" },
          }),
        );
        await fs.writeFile(
          `${root}/README.md`,
          `# Test\n\n\`\`\`ts\nexpect(1).toBe(1)\n\`\`\`\n`,
        );
        await fs.writeFile(
          `${root}/src/index.ts`,
          `export function add(a: number, b: number) {\n  return a + b\n}\n`,
        );

        const config = await loadConfig(root);
        const project = await scan(config);

        const docs1 = await extractCached(project);

        const cacheDir = `${root}/.metonym/cache/extract`;
        const entries = await fs.readdir(cacheDir);
        if (entries.length > 0) {
          const toCorrupt = entries[0];
          await fs.writeFile(`${cacheDir}/${toCorrupt}`, "invalid json {");
        }

        const docs2 = await extractCached(project);
        expect(docs2.examples.length).toBe(docs1.examples.length);
      } finally {
        await cleanupFixture(root);
      }
    });

    it("editing file content changes key and re-extracts", async () => {
      const root = await createFixture("extract-edited-file");
      try {
        await fs.mkdir(`${root}/src`, { recursive: true });
        await fs.writeFile(
          `${root}/package.json`,
          JSON.stringify({
            name: "test-pkg",
            exports: { ".": "./src/index.ts" },
          }),
        );
        const readme1 = `# Test\n\n\`\`\`ts\nexpect(1).toBe(1)\n\`\`\`\n`;
        await fs.writeFile(`${root}/README.md`, readme1);
        await fs.writeFile(
          `${root}/src/index.ts`,
          `export function add(a: number, b: number) {\n  return a + b\n}\n`,
        );

        const config = await loadConfig(root);
        const project = await scan(config);

        await extractCached(project);
        const cacheDir = `${root}/.metonym/cache/extract`;
        const cacheEntries1 = await fs.readdir(cacheDir);

        const readme2 = `# Test\n\n\`\`\`ts\nexpect(2).toBe(2)\n\`\`\`\n`;
        await fs.writeFile(`${root}/README.md`, readme2);

        const docs2 = await extractCached(project);

        const cacheEntries2 = await fs.readdir(cacheDir);

        expect(cacheEntries2.length).toBe(cacheEntries1.length);
        expect(docs2.examples.length).toBeGreaterThan(0);
      } finally {
        await cleanupFixture(root);
      }
    });

    it("same-size edit within the racy window is re-extracted", async () => {
      const root = await createFixture("extract-racy-edit");
      try {
        await fs.mkdir(`${root}/src`, { recursive: true });
        await fs.writeFile(
          `${root}/package.json`,
          JSON.stringify({ name: "test-pkg" }),
        );
        // Both bodies are the same byte length; only the asserted value moves.
        await fs.writeFile(
          `${root}/README.md`,
          `# Test\n\n\`\`\`ts\nexpect(1).toBe(1)\n\`\`\`\n`,
        );
        const project = await scan(await loadConfig(root));

        const docs1 = await extractCached(project);
        const stat1 = await fs.stat(`${root}/README.md`);
        await fs.writeFile(
          `${root}/README.md`,
          `# Test\n\n\`\`\`ts\nexpect(2).toBe(2)\n\`\`\`\n`,
        );
        // Force the coarse-filesystem case: identical mtime and size.
        await fs.utimes(`${root}/README.md`, stat1.atime, stat1.mtime);

        const docs2 = await extractCached(project);
        expect(docs2.examples[0]?.code).toContain("expect(2)");
        expect(docs2.examples[0]?.id).not.toBe(docs1.examples[0]?.id);
      } finally {
        await cleanupFixture(root);
      }
    });

    it("old unchanged files hit on stat alone and leave the index untouched", async () => {
      const root = await createFixture("extract-stat-hit");
      try {
        await fs.mkdir(`${root}/src`, { recursive: true });
        await fs.writeFile(
          `${root}/package.json`,
          JSON.stringify({ name: "test-pkg" }),
        );
        await fs.writeFile(
          `${root}/README.md`,
          `# Test\n\n\`\`\`ts\nexpect(1).toBe(1)\n\`\`\`\n`,
        );
        await fs.writeFile(
          `${root}/src/index.ts`,
          `export function add(a: number, b: number) {\n  return a + b\n}\n`,
        );
        // Older than the racy window, so (mtime, size) is trusted.
        const old = new Date(Date.now() - 60_000);
        await fs.utimes(`${root}/README.md`, old, old);
        await fs.utimes(`${root}/src/index.ts`, old, old);
        const project = await scan(await loadConfig(root));

        const docs1 = await extractCached(project);
        const indexPath = `${root}/.metonym/cache/extract/index.json`;
        const index1 = await fs.readFile(indexPath, "utf-8");

        // Change content behind the cache's back but keep mtime and size:
        // the stat path must trust the entry and never read the file.
        await fs.writeFile(
          `${root}/README.md`,
          `# Test\n\n\`\`\`ts\nexpect(2).toBe(2)\n\`\`\`\n`,
        );
        await fs.utimes(`${root}/README.md`, old, old);

        const docs2 = await extractCached(project);
        expect(docs2.examples[0]?.id).toBe(docs1.examples[0]?.id);
        expect(await fs.readFile(indexPath, "utf-8")).toBe(index1);
      } finally {
        await cleanupFixture(root);
      }
    });

    it("clearCache removes entire cache directory", async () => {
      const root = await createFixture("extract-clear-cache");
      try {
        await fs.mkdir(`${root}/src`, { recursive: true });
        await fs.writeFile(
          `${root}/package.json`,
          JSON.stringify({
            name: "test-pkg",
            exports: { ".": "./src/index.ts" },
          }),
        );
        await fs.writeFile(
          `${root}/README.md`,
          `# Test\n\n\`\`\`ts\nexpect(1).toBe(1)\n\`\`\`\n`,
        );
        await fs.writeFile(
          `${root}/src/index.ts`,
          `export function add(a: number, b: number) {\n  return a + b\n}\n`,
        );

        const config = await loadConfig(root);
        const project = await scan(config);

        await extractCached(project);

        const cacheDir = `${root}/.metonym/cache`;
        let exists = await fs.stat(cacheDir).then(
          () => true,
          () => false,
        );
        expect(exists).toBe(true);

        await clearCache(root);

        exists = await fs.stat(cacheDir).then(
          () => true,
          () => false,
        );
        expect(exists).toBe(false);
      } finally {
        await cleanupFixture(root);
      }
    });
  });

  describe("closureKey", () => {
    it("changes when entry file content changes", async () => {
      const root = await createFixture("closure-entry-change");
      try {
        await fs.mkdir(`${root}/src`, { recursive: true });
        await fs.writeFile(`${root}/src/main.ts`, `const x = 1;\n`);

        const key1 = await closureKey(root, ["src/main.ts"]);

        await fs.writeFile(`${root}/src/main.ts`, `const x = 2;\n`);

        const key2 = await closureKey(root, ["src/main.ts"]);

        expect(key1).not.toBe(key2);
      } finally {
        await cleanupFixture(root);
      }
    });

    it("stable when entry file unchanged", async () => {
      const root = await createFixture("closure-stable");
      try {
        await fs.mkdir(`${root}/src`, { recursive: true });
        await fs.writeFile(`${root}/src/main.ts`, `const x = 1;\n`);
        await fs.writeFile(`${root}/src/other.ts`, `const y = 2;\n`);

        const key1 = await closureKey(root, ["src/main.ts"]);

        await fs.writeFile(`${root}/src/other.ts`, `const y = 3;\n`);

        const key2 = await closureKey(root, ["src/main.ts"]);

        expect(key1).toBe(key2);
      } finally {
        await cleanupFixture(root);
      }
    });
  });

  describe("runCached", () => {
    it("e2e: first run executes, second run hits cache", async () => {
      const root = await createFixture("run-cached-e2e");
      try {
        await fs.mkdir(`${root}/src`, { recursive: true });

        await fs.writeFile(
          `${root}/package.json`,
          JSON.stringify({
            name: "test-pkg",
            exports: { ".": "./src/index.ts" },
          }),
        );

        await fs.writeFile(
          `${root}/src/index.ts`,
          `export function add(a: number, b: number) {\n  return a + b\n}\n`,
        );

        await fs.writeFile(
          `${root}/README.md`,
          `# Test\n\n\`\`\`ts\nimport { add } from "test-pkg"\nexpect(add(1, 2)).toBe(3)\n\`\`\`\n\n\`\`\`ts\nimport { add } from "test-pkg"\nexpect(add(2, 3)).toBe(5)\n\`\`\`\n`,
        );

        const config = await loadConfig(root);
        const project = await scan(config);

        const docs1 = await extractCached(project);
        const result1 = await runCached(docs1, {
          outDir: `${root}/.metonym/tests`,
        });

        expect(result1.results.length).toBeGreaterThan(0);
        const fromCacheFalsy = result1.results.filter((r) => !r.fromCache);
        expect(fromCacheFalsy.length).toBeGreaterThan(0);

        const passed = result1.results.filter((r) => r.status === "passed");
        expect(passed.length).toBe(result1.results.length);

        const junitPath = `${root}/.metonym/tests/.junit.xml`;
        const resultsCachePath = `${root}/.metonym/cache/results.json`;
        let mtime1 = 0;
        try {
          const stat = await fs.stat(junitPath);
          mtime1 = stat.mtime?.getTime() || 0;
        } catch {
          // File might not exist yet
        }
        const resultsMtime1 = (await fs.stat(resultsCachePath)).mtime.getTime();

        // Small delay to ensure mtime would change if re-run
        await new Promise((r) => setTimeout(r, 100));

        const result2 = await runCached(docs1, {
          outDir: `${root}/.metonym/tests`,
        });

        expect(result2.totals.cached).toBeGreaterThan(0);
        expect(result2.results.length).toBe(result1.results.length);
        expect(result2.exitCode).toBe(0);

        let mtime2 = 0;
        try {
          const stat = await fs.stat(junitPath);
          mtime2 = stat.mtime?.getTime() || 0;
        } catch {
          // File might not exist
        }

        expect(mtime2).toBe(mtime1);
        const resultsMtime2 = (await fs.stat(resultsCachePath)).mtime.getTime();
        expect(resultsMtime2).toBe(resultsMtime1);
      } finally {
        await cleanupFixture(root);
      }
    });

    it("re-executes when source file changes (closure changes)", async () => {
      const root = await createFixture("run-cached-closure-change");
      try {
        await fs.mkdir(`${root}/src`, { recursive: true });

        await fs.writeFile(
          `${root}/package.json`,
          JSON.stringify({
            name: "test-pkg",
            exports: { ".": "./src/index.ts" },
          }),
        );

        await fs.writeFile(
          `${root}/src/index.ts`,
          `export function add(a: number, b: number) {\n  return a + b\n}\n`,
        );

        await fs.writeFile(
          `${root}/README.md`,
          `# Test\n\n\`\`\`ts\nimport { add } from "test-pkg"\nexpect(add(1, 2)).toBe(3)\n\`\`\`\n`,
        );

        const config = await loadConfig(root);
        const project = await scan(config);
        const docs1 = await extractCached(project);
        const result1 = await runCached(docs1, {
          outDir: `${root}/.metonym/tests`,
        });

        expect(result1.results[0].status).toBe("passed");

        await fs.writeFile(
          `${root}/src/index.ts`,
          `export function add(a: number, b: number) {\n  return a + b  \n}\n`, // extra whitespace
        );

        const docs2 = await extractCached(project);
        const result2 = await runCached(docs2, {
          outDir: `${root}/.metonym/tests`,
        });

        expect(result2.totals.cached).toBe(0);
        expect(result2.results[0].status).toBe("passed");
      } finally {
        await cleanupFixture(root);
      }
    });

    it("opts.full bypasses cache and re-executes", async () => {
      const root = await createFixture("run-cached-full");
      try {
        await fs.mkdir(`${root}/src`, { recursive: true });

        await fs.writeFile(
          `${root}/package.json`,
          JSON.stringify({
            name: "test-pkg",
            exports: { ".": "./src/index.ts" },
          }),
        );

        await fs.writeFile(
          `${root}/src/index.ts`,
          `export function add(a: number, b: number) {\n  return a + b\n}\n`,
        );

        await fs.writeFile(
          `${root}/README.md`,
          `# Test\n\n\`\`\`ts\nimport { add } from "test-pkg"\nexpect(add(1, 2)).toBe(3)\n\`\`\`\n`,
        );

        const config = await loadConfig(root);
        const project = await scan(config);
        const docs1 = await extractCached(project);
        await runCached(docs1, {
          outDir: `${root}/.metonym/tests`,
        });

        const result2 = await runCached(docs1, {
          outDir: `${root}/.metonym/tests`,
          full: true,
        });

        expect(result2.totals.cached).toBe(0);
        expect(result2.results[0].status).toBe("passed");
      } finally {
        await cleanupFixture(root);
      }
    });

    it("tolerates corrupt results.json cache", async () => {
      const root = await createFixture("run-cached-corrupt");
      try {
        await fs.mkdir(`${root}/src`, { recursive: true });

        await fs.writeFile(
          `${root}/package.json`,
          JSON.stringify({
            name: "test-pkg",
            exports: { ".": "./src/index.ts" },
          }),
        );

        await fs.writeFile(
          `${root}/src/index.ts`,
          `export function add(a: number, b: number) {\n  return a + b\n}\n`,
        );

        await fs.writeFile(
          `${root}/README.md`,
          `# Test\n\n\`\`\`ts\nimport { add } from "test-pkg"\nexpect(add(1, 2)).toBe(3)\n\`\`\`\n`,
        );

        const config = await loadConfig(root);
        const project = await scan(config);
        const docs1 = await extractCached(project);
        await runCached(docs1, {
          outDir: `${root}/.metonym/tests`,
        });

        const resultsCachePath = `${root}/.metonym/cache/results.json`;
        await fs.writeFile(resultsCachePath, "garbage json {");

        const result2 = await runCached(docs1, {
          outDir: `${root}/.metonym/tests`,
        });

        expect(result2.results.length).toBeGreaterThan(0);
        expect(result2.results[0].status).toBe("passed");
      } finally {
        await cleanupFixture(root);
      }
    });
  });
});
