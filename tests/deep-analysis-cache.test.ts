import { beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { readdir, rm } from "node:fs/promises";
import {
  assembleDocumentationSet,
  type DocumentationSet,
  extractJsdoc,
  extractMarkdown,
  scanSymbols,
} from "metonym";
import { enrichWithTypeScriptCached } from "../src/cache/deep-analysis-cache";
import { contentKey } from "../src/cache/keys";

const TS_PATH = Bun.resolveSync("typescript", `${import.meta.dir}/..`);

function writeFixture(fixture: string, addFn: string): void {
  mkdirSync(`${fixture}/src`, { recursive: true });
  writeFileSync(
    `${fixture}/package.json`,
    JSON.stringify({
      name: "deep-cache-pkg",
      exports: { ".": "./src/index.ts" },
    }),
  );
  writeFileSync(
    `${fixture}/src/index.ts`,
    `/** Adds two numbers. */
export function add(a: number, b: number): number {
  return a + b;
}
${addFn}
`,
  );
  writeFileSync(
    `${fixture}/README.md`,
    `# deep-cache-pkg

\`\`\`ts
import { add } from "deep-cache-pkg";
expect(add(1, 2)).toBe(3);
\`\`\`
`,
  );
}

async function buildDocs(fixture: string): Promise<DocumentationSet> {
  const languages = ["ts", "tsx", "js", "jsx"];
  const parts = [];

  const readmeText = await Bun.file(`${fixture}/README.md`).text();
  const readme = extractMarkdown(readmeText, { file: "README.md", languages });
  parts.push({
    file: "README.md",
    document: readme.document,
    examples: readme.examples,
    symbols: [],
  });

  const srcText = await Bun.file(`${fixture}/src/index.ts`).text();
  const src = extractJsdoc(srcText, { file: "src/index.ts", languages });
  const symbols = scanSymbols("src/index.ts", srcText);
  parts.push({
    file: "src/index.ts",
    document: src.document,
    examples: src.examples,
    symbols,
  });

  return assembleDocumentationSet(fixture, parts);
}

describe("enrichWithTypeScriptCached", () => {
  let fixture: string;

  beforeEach(() => {
    fixture = mkdtempSync("/tmp/.deep-analysis-cache-fixture-");
  });

  test("cache miss writes a single entry under .metonym/cache/deep", async () => {
    writeFixture(fixture, "");
    const docs = await buildDocs(fixture);

    await enrichWithTypeScriptCached(docs, { tsPath: TS_PATH });

    const entries = await readdir(`${fixture}/.metonym/cache/deep`);
    expect(entries.length).toBe(1);
    expect(entries[0]).toMatch(/\.json$/);
  });

  test("warm call returns the same enrichment as a cold call", async () => {
    writeFixture(fixture, "");
    const docs = await buildDocs(fixture);

    const cold = await enrichWithTypeScriptCached(docs, { tsPath: TS_PATH });
    const warm = await enrichWithTypeScriptCached(docs, { tsPath: TS_PATH });

    expect(JSON.stringify(warm.docs)).toEqual(JSON.stringify(cold.docs));
    expect(warm.diagnostics).toEqual(cold.diagnostics);
  });

  test("caller-supplied file keys select the same entry as hashing", async () => {
    writeFixture(fixture, "");
    const docs = await buildDocs(fixture);
    const cacheDir = `${fixture}/.metonym/cache/deep`;

    const cold = await enrichWithTypeScriptCached(docs, { tsPath: TS_PATH });
    const [entry] = await readdir(cacheDir);

    const srcText = await Bun.file(`${fixture}/src/index.ts`).text();
    const fileKeys = new Map([["src/index.ts", contentKey(srcText)]]);
    const keyed = await enrichWithTypeScriptCached(docs, {
      tsPath: TS_PATH,
      fileKeys,
    });
    expect(await readdir(cacheDir)).toEqual([entry]);
    expect(JSON.stringify(keyed.docs)).toEqual(JSON.stringify(cold.docs));

    // A different key must miss: the entry is replaced, not reused.
    await enrichWithTypeScriptCached(docs, {
      tsPath: TS_PATH,
      fileKeys: new Map([["src/index.ts", "0000000000000000"]]),
    });
    const [replaced] = await readdir(cacheDir);
    expect(replaced).not.toBe(entry);
  });

  test("warm call is dramatically faster than a cold call", async () => {
    writeFixture(fixture, "");
    const docs = await buildDocs(fixture);

    const t0 = performance.now();
    await enrichWithTypeScriptCached(docs, { tsPath: TS_PATH });
    const coldMs = performance.now() - t0;

    const t1 = performance.now();
    await enrichWithTypeScriptCached(docs, { tsPath: TS_PATH });
    const warmMs = performance.now() - t1;

    expect(warmMs).toBeLessThan(coldMs / 2);
  });

  test("changing a source file invalidates the cache", async () => {
    writeFixture(fixture, "");
    const docs1 = await buildDocs(fixture);
    const first = await enrichWithTypeScriptCached(docs1, { tsPath: TS_PATH });
    const firstEntries = await readdir(`${fixture}/.metonym/cache/deep`);

    writeFixture(
      fixture,
      `/** Subtracts two numbers. */
export function subtract(a: number, b: number): number {
  return a - b;
}`,
    );
    const docs2 = await buildDocs(fixture);
    const second = await enrichWithTypeScriptCached(docs2, { tsPath: TS_PATH });
    const secondEntries = await readdir(`${fixture}/.metonym/cache/deep`);

    // Single-slot cache: still exactly one entry, but a different key/content.
    expect(secondEntries.length).toBe(1);
    expect(secondEntries[0]).not.toBe(firstEntries[0]);
    expect(second.docs.symbols.some((s) => s.name === "subtract")).toBe(true);
    expect(first.docs.symbols.some((s) => s.name === "subtract")).toBe(false);
  });

  test("a corrupt cache entry is ignored, not thrown", async () => {
    writeFixture(fixture, "");
    const docs = await buildDocs(fixture);

    await enrichWithTypeScriptCached(docs, { tsPath: TS_PATH });
    const entries = await readdir(`${fixture}/.metonym/cache/deep`);
    await Bun.write(
      `${fixture}/.metonym/cache/deep/${entries[0]}`,
      "not valid json {",
    );

    const result = await enrichWithTypeScriptCached(docs, { tsPath: TS_PATH });
    expect(result.docs.symbols.length).toBeGreaterThan(0);
  });

  test("clearing .metonym/cache removes deep-analysis entries too", async () => {
    writeFixture(fixture, "");
    const docs = await buildDocs(fixture);
    await enrichWithTypeScriptCached(docs, { tsPath: TS_PATH });

    await rm(`${fixture}/.metonym/cache`, { recursive: true, force: true });

    const result = await enrichWithTypeScriptCached(docs, { tsPath: TS_PATH });
    expect(result.docs.symbols.length).toBeGreaterThan(0);
    const entries = await readdir(`${fixture}/.metonym/cache/deep`);
    expect(entries.length).toBe(1);
  });
});
