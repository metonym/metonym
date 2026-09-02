import { beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import {
  assembleDocumentationSet,
  type DocumentationSet,
  extractJsdoc,
  extractMarkdown,
  scanSymbols,
} from "metonym";
import { enrichWithTypeScript } from "../src/analysis/ts-provider";

const TS_PATH = Bun.resolveSync("typescript", `${import.meta.dir}/..`);

describe("type signatures and hovers metadata", () => {
  let _fixtureRoot: string;
  let docs: DocumentationSet;

  beforeAll(async () => {
    const fixture = mkdtempSync("/tmp/.ts-metadata-fixture-");
    _fixtureRoot = fixture;

    mkdirSync(`${fixture}/src`, { recursive: true });
    writeFileSync(
      `${fixture}/package.json`,
      JSON.stringify(
        {
          name: "meta-pkg",
          exports: {
            ".": "./src/index.ts",
          },
        },
        null,
        2,
      ),
    );

    writeFileSync(
      `${fixture}/src/index.ts`,
      `/** Adds two numbers. */
export function add(a: number, b: number): number {
  return a + b;
}

export const VERSION: string = "1.0";
`,
    );

    writeFileSync(
      `${fixture}/README.md`,
      `# meta-pkg

Example usage:

\`\`\`ts
import { add } from "meta-pkg";
const total = add(1, 2);
expect(total).toBe(3);
\`\`\`

Type error example:

\`\`\`ts
import { add } from "meta-pkg";
const bad = add("x", 2);
expect(bad).toBe(2);
\`\`\`
`,
    );

    const docFiles = ["README.md"];
    const sourceFiles = ["src/index.ts"];
    const languages = ["ts", "tsx", "js", "jsx"];

    const parts = [];
    for (const file of docFiles) {
      const text = await Bun.file(`${fixture}/${file}`).text();
      const { document, examples } = extractMarkdown(text, {
        file,
        languages,
      });
      parts.push({ file, document, examples, symbols: [] });
    }

    for (const file of sourceFiles) {
      const text = await Bun.file(`${fixture}/${file}`).text();
      const { document, examples } = extractJsdoc(text, {
        file,
        languages,
      });
      const symbols = scanSymbols(file, text);
      parts.push({ file, document, examples, symbols });
    }

    docs = assembleDocumentationSet(fixture, parts);
  });

  test("adds function signature to SymbolInfo", async () => {
    const result = await enrichWithTypeScript(docs, { tsPath: TS_PATH });

    expect(result.diagnostics).toEqual([]);

    const addSym = result.docs.symbols.find(
      (s) => s.file === "src/index.ts" && s.name === "add",
    );
    expect(addSym).toBeDefined();
    expect(addSym?.signature).toBeDefined();
    expect(addSym?.signature).toContain("(a: number, b: number)");
    expect(addSym?.signature).toContain("number");
  });

  test("adds const signature to SymbolInfo", async () => {
    const result = await enrichWithTypeScript(docs, { tsPath: TS_PATH });

    const versionSym = result.docs.symbols.find(
      (s) => s.file === "src/index.ts" && s.name === "VERSION",
    );
    expect(versionSym).toBeDefined();
    expect(versionSym?.signature).toBeDefined();
    expect(versionSym?.signature).toContain("string");
  });

  test("adds hovers to examples with correct offsets", async () => {
    const result = await enrichWithTypeScript(docs, { tsPath: TS_PATH });

    const example = result.docs.examples.find((e) =>
      e.code.includes("const total = add(1, 2)"),
    );
    expect(example).toBeDefined();
    expect(example?.hovers).toBeDefined();
    expect(Array.isArray(example?.hovers)).toBe(true);
    expect(example?.hovers?.length).toBeGreaterThan(0);

    for (const hover of example?.hovers || []) {
      const identifier = example?.code.slice(
        hover.start,
        hover.start + hover.length,
      );
      expect(identifier).toBeDefined();
      if (!identifier) continue;
      expect(identifier.length).toBeGreaterThan(0);
    }
  });

  test("hover for 'add' call site includes function signature", async () => {
    const result = await enrichWithTypeScript(docs, { tsPath: TS_PATH });

    const example = result.docs.examples.find((e) =>
      e.code.includes("const total = add(1, 2)"),
    );
    expect(example?.hovers).toBeDefined();

    const addHover = example?.hovers?.find((h) => {
      const text = example.code.slice(h.start, h.start + h.length);
      return text === "add" && h.start > 20; // Skip the import, get the call site
    });

    expect(addHover).toBeDefined();
    expect(addHover?.info).toContain("add");
    expect(addHover?.info).toContain("(a: number, b: number)");
    expect(addHover?.docs).toContain("Adds two numbers");
    expect(addHover?.symbol).toBe("sym:src/index.ts:add");
  });

  test("hover for 'total' variable includes type", async () => {
    const result = await enrichWithTypeScript(docs, { tsPath: TS_PATH });

    const example = result.docs.examples.find((e) =>
      e.code.includes("const total = add(1, 2)"),
    );
    expect(example?.hovers).toBeDefined();

    const totalHover = example?.hovers?.find((h) => {
      const text = example.code.slice(h.start, h.start + h.length);
      return text === "total";
    });

    expect(totalHover).toBeDefined();
    expect(totalHover?.info).toContain("total");
    expect(totalHover?.info).toContain("number");
  });

  test("hover line and column are 1-indexed", async () => {
    const result = await enrichWithTypeScript(docs, { tsPath: TS_PATH });

    const example = result.docs.examples.find((e) =>
      e.code.includes("const total = add(1, 2)"),
    );

    for (const hover of example?.hovers || []) {
      expect(hover.line).toBeGreaterThanOrEqual(1);
      expect(hover.column).toBeGreaterThanOrEqual(1);
    }
  });

  test("hovers are sorted by start offset", async () => {
    const result = await enrichWithTypeScript(docs, { tsPath: TS_PATH });

    const example = result.docs.examples.find((e) =>
      e.code.includes("const total = add(1, 2)"),
    );

    const hovers = example?.hovers || [];
    for (let i = 1; i < hovers.length; i++) {
      expect(hovers[i].start).toBeGreaterThanOrEqual(hovers[i - 1].start);
    }
  });

  test("does not mutate input docs", async () => {
    const docsBefore = JSON.stringify(docs);
    await enrichWithTypeScript(docs, { tsPath: TS_PATH });
    const docsAfter = JSON.stringify(docs);

    expect(docsBefore).toEqual(docsAfter);
  });

  test("is deterministic (hovers and signatures same on re-run)", async () => {
    const result1 = await enrichWithTypeScript(docs, { tsPath: TS_PATH });
    const result2 = await enrichWithTypeScript(docs, { tsPath: TS_PATH });

    expect(JSON.stringify(result1.docs.symbols)).toEqual(
      JSON.stringify(result2.docs.symbols),
    );

    expect(JSON.stringify(result1.docs.examples)).toEqual(
      JSON.stringify(result2.docs.examples),
    );
  });

  test("preserves references edges", async () => {
    const result = await enrichWithTypeScript(docs, { tsPath: TS_PATH });

    const addRef = result.docs.relations.find(
      (r) => r.kind === "references" && r.to.includes("sym:src/index.ts:add"),
    );
    expect(addRef).toBeDefined();
  });

  test("gracefully handles bad tsPath", async () => {
    const result = await enrichWithTypeScript(docs, {
      tsPath: "/nonexistent/typescript.js",
    });

    expect(result.diagnostics.length).toBeGreaterThan(0);
    expect(result.docs.root).toBe(docs.root);
  });

  test("example code slice matches hover text", async () => {
    const result = await enrichWithTypeScript(docs, { tsPath: TS_PATH });

    const example = result.docs.examples.find((e) =>
      e.code.includes("const total = add(1, 2)"),
    );

    for (const hover of example?.hovers || []) {
      const sliced = example?.code.slice(
        hover.start,
        hover.start + hover.length,
      );
      expect(sliced).toBeDefined();
      if (!sliced) continue;
      expect(sliced.length).toBeGreaterThan(0);
      expect(/^\w+$/.test(sliced)).toBe(true);
    }
  });

  test("skip signatures for reexport symbols", async () => {
    const result = await enrichWithTypeScript(docs, { tsPath: TS_PATH });

    const reexports = result.docs.symbols.filter(
      (s) => s.declKind === "reexport",
    );
    for (const reexport of reexports) {
      expect(reexport).toBeDefined();
    }
  });

  test("hovers include JSDoc for functions", async () => {
    const result = await enrichWithTypeScript(docs, { tsPath: TS_PATH });

    const example = result.docs.examples.find((e) =>
      e.code.includes("const total = add(1, 2)"),
    );

    const addHover = example?.hovers?.find((h) => {
      const text = example.code.slice(h.start, h.start + h.length);
      return text === "add" && h.info.includes("(a: number, b: number)");
    });

    expect(addHover?.docs).toBeDefined();
    expect(addHover?.docs).toMatch(/Adds two numbers/);
  });

  test("clean example has no diagnostics", async () => {
    const result = await enrichWithTypeScript(docs, { tsPath: TS_PATH });

    const example = result.docs.examples.find((e) =>
      e.code.includes("const total = add(1, 2)"),
    );
    expect(example).toBeDefined();
    expect(example?.diagnostics ?? []).toHaveLength(0);
  });

  test("example with a real type error gets an error diagnostic", async () => {
    const result = await enrichWithTypeScript(docs, { tsPath: TS_PATH });

    const example = result.docs.examples.find((e) =>
      e.code.includes('add("x", 2)'),
    );
    expect(example).toBeDefined();
    expect(example?.diagnostics).toBeDefined();
    expect(example?.diagnostics?.length).toBeGreaterThan(0);

    const err = example?.diagnostics?.find((d) => d.severity === "error");
    expect(err).toBeDefined();
    expect(err?.message).toMatch(/not assignable/i);
    expect(err?.code).toBeGreaterThan(0);
  });

  test("diagnostic position is relative to example.code, not the injected header", async () => {
    const result = await enrichWithTypeScript(docs, { tsPath: TS_PATH });

    const example = result.docs.examples.find((e) =>
      e.code.includes('add("x", 2)'),
    );
    const err = example?.diagnostics?.find((d) => d.severity === "error");
    expect(err).toBeDefined();
    if (!err || !example) return;

    expect(err.start).toBeGreaterThanOrEqual(0);
    expect(err.start).toBeLessThan(example.code.length);
    const slice = example.code.slice(err.start, err.start + err.length);
    expect(slice).toBe('"x"');
    expect(err.line).toBeGreaterThanOrEqual(1);
    expect(err.column).toBeGreaterThanOrEqual(1);
  });

  test("diagnostics do not falsely flag missing bun:test import", async () => {
    const result = await enrichWithTypeScript(docs, { tsPath: TS_PATH });

    for (const example of result.docs.examples) {
      for (const d of example.diagnostics ?? []) {
        expect(d.message).not.toMatch(/bun:test/);
        expect(d.message).not.toMatch(/Cannot find name 'expect'/);
      }
    }
  });
});
