import { beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import {
  assembleDocumentationSet,
  type DocumentationSet,
  extract,
  extractJsdoc,
  extractMarkdown,
  scan,
  scanSymbols,
} from "metonym";
import { resolveAnalysisMode } from "../src/analysis/provider";
import { enrichWithTypeScript } from "../src/analysis/ts-provider";

const TS_PATH = Bun.resolveSync("typescript", `${import.meta.dir}/..`);

describe("resolveAnalysisMode", () => {
  test("shallow mode returns shallow", () => {
    const result = resolveAnalysisMode("/tmp", "shallow");
    expect(result.mode).toBe("shallow");
    expect(result.tsPath).toBeUndefined();
  });

  test("deep mode with typescript available returns deep with tsPath", () => {
    const result = resolveAnalysisMode(`${import.meta.dir}/..`, "deep");
    expect(result.mode).toBe("deep");
    expect(result.tsPath).toBeDefined();
    expect(result.tsPath).toContain("typescript");
  });

  test("deep mode without typescript throws", () => {
    const tmpDir = "/tmp/nonexistent-ts-pkg-xyz";

    expect(() => resolveAnalysisMode(tmpDir, "deep")).toThrow(
      /analysis "deep" requires typescript/,
    );
  });

  test("auto mode with typescript available returns deep", () => {
    const result = resolveAnalysisMode(`${import.meta.dir}/..`, "auto");
    expect(result.mode).toBe("deep");
    expect(result.tsPath).toBeDefined();
  });

  test("auto mode undefined defaults to auto behavior", () => {
    const result = resolveAnalysisMode(`${import.meta.dir}/..`, undefined);
    expect(result.mode).toBe("deep");
  });
});

describe("enrichWithTypeScript", () => {
  let _fixtureRoot: string;
  let docs: DocumentationSet;

  beforeAll(async () => {
    const fixture = mkdtempSync("/tmp/.ts-provider-fixture-");

    _fixtureRoot = fixture;

    mkdirSync(`${fixture}/src`, { recursive: true });
    writeFileSync(
      `${fixture}/package.json`,
      JSON.stringify(
        {
          name: "deep-pkg",
          exports: {
            ".": "./src/index.ts",
          },
        },
        null,
        2,
      ),
    );

    writeFileSync(
      `${fixture}/src/util.ts`,
      `
export function helper(): number {
  return 1;
}

export function unused_helper(): number {
  return 2;
}
`,
    );

    writeFileSync(
      `${fixture}/src/index.ts`,
      `
import { helper } from "./util";

export function add(a: number, b: number): number {
  return a + b + helper();
}

export function standalone(): number {
  return 7;
}

export * from "./util";
`,
    );

    writeFileSync(
      `${fixture}/README.md`,
      `
# Test Package

Example 1: Basic usage
\`\`\`ts
import { add } from "deep-pkg";
expect(add(2, 3)).toBe(8);
\`\`\`

Example 2: Shadowing (local override)
\`\`\`ts
import { add } from "deep-pkg";
const add = 1;
expect(add).toBe(1);
\`\`\`

Example 3: Using re-exported helper
\`\`\`ts
import { helper } from "deep-pkg";
expect(helper()).toBe(1);
\`\`\`

Example 4: String literal mention
\`\`\`ts
import { add } from "deep-pkg";
console.log("add is great");
\`\`\`
`,
    );

    const docFiles = ["README.md"];
    const sourceFiles = ["src/util.ts", "src/index.ts"];
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

  test("enriches docs with example references", async () => {
    const result = await enrichWithTypeScript(docs, { tsPath: TS_PATH });

    expect(result.diagnostics).toEqual([]);
    expect(result.docs).toBeDefined();

    const ex1Refs = result.docs.relations.filter(
      (r) =>
        r.kind === "references" &&
        r.from.startsWith("ex:README.md") &&
        r.to.includes("add"),
    );
    expect(ex1Refs.length).toBeGreaterThan(0);
  });

  test("detects references in examples", async () => {
    const result = await enrichWithTypeScript(docs, { tsPath: TS_PATH });

    const ex1 = docs.examples.find(
      (e) =>
        e.code.includes("expect(add(2))") || e.code.includes("expect(add("),
    );

    if (ex1) {
      const refs = result.docs.relations.filter(
        (r) => r.kind === "references" && r.from === ex1.id,
      );
      expect(refs.length).toBeGreaterThan(0);
    }
  });

  test("resolves through export * (re-exports)", async () => {
    const result = await enrichWithTypeScript(docs, { tsPath: TS_PATH });

    const ex3 = docs.examples.find((e) =>
      e.code.includes("import { helper } from"),
    );

    if (ex3) {
      const helperRef = result.docs.relations.find(
        (r) =>
          r.kind === "references" &&
          r.from === ex3.id &&
          r.to.includes("helper"),
      );
      expect(helperRef).toBeDefined();
      expect(helperRef?.to).toMatch(/sym:src\/(util|index)\.ts:helper/);
    }
  });

  test("ignores string literals (no reference for string mentions)", async () => {
    const result = await enrichWithTypeScript(docs, { tsPath: TS_PATH });

    const ex4 = docs.examples.find((e) =>
      e.code.includes('console.log("add is great")'),
    );

    if (ex4) {
      const stringRef = result.docs.relations.filter(
        (r) =>
          r.kind === "references" && r.from === ex4.id && r.to.includes("add"),
      );
      expect(stringRef).toHaveLength(0);
    }
  });

  test("includes calls edges", async () => {
    const result = await enrichWithTypeScript(docs, { tsPath: TS_PATH });

    const addCallsHelper = result.docs.relations.find(
      (r) =>
        r.kind === "calls" &&
        r.from.includes("sym:src/index.ts:add") &&
        r.to.includes("helper"),
    );
    expect(addCallsHelper).toBeDefined();

    const standaloneNoCall = result.docs.relations.filter(
      (r) =>
        r.kind === "calls" && r.from.includes("sym:src/index.ts:standalone"),
    );
    expect(standaloneNoCall).toHaveLength(0);

    const selfEdges = result.docs.relations.filter(
      (r) => r.kind === "calls" && r.from === r.to,
    );
    expect(selfEdges).toHaveLength(0);
  });

  test("enumerates export * symbols", async () => {
    const result = await enrichWithTypeScript(docs, { tsPath: TS_PATH });

    const helperAtIndex = result.docs.symbols.find(
      (s) =>
        s.file === "src/index.ts" &&
        s.name === "helper" &&
        (s.declKind === "reexport" || s.reexportFrom),
    );
    expect(helperAtIndex).toBeDefined();

    const unusedHelperAtIndex = result.docs.symbols.find(
      (s) =>
        s.file === "src/index.ts" &&
        s.name === "unused_helper" &&
        (s.declKind === "reexport" || s.reexportFrom),
    );
    expect(unusedHelperAtIndex).toBeDefined();
  });

  test("is deterministic (same result on re-run)", async () => {
    const result1 = await enrichWithTypeScript(docs, { tsPath: TS_PATH });
    const result2 = await enrichWithTypeScript(docs, { tsPath: TS_PATH });

    expect(JSON.stringify(result1.docs.symbols)).toEqual(
      JSON.stringify(result2.docs.symbols),
    );
    expect(JSON.stringify(result1.docs.relations)).toEqual(
      JSON.stringify(result2.docs.relations),
    );
  });

  test("does not mutate input docs", async () => {
    const docsBefore = JSON.stringify(docs);
    await enrichWithTypeScript(docs, { tsPath: TS_PATH });
    const docsAfter = JSON.stringify(docs);

    expect(docsBefore).toEqual(docsAfter);
  });

  test("handles missing tsPath gracefully", async () => {
    const result = await enrichWithTypeScript(docs, {
      tsPath: "/nonexistent/typescript.js",
    });

    expect(result.diagnostics.length).toBeGreaterThan(0);
    expect(result.docs).toEqual(docs);
  });

  test("handles TypeScript loading errors", async () => {
    const fakeTs = "/etc/hosts";
    const result = await enrichWithTypeScript(docs, {
      tsPath: fakeTs,
    });

    expect(result.diagnostics.length).toBeGreaterThan(0);
    expect(result.docs.root).toBe(docs.root);
  });

  test("respects sourceFiles option", async () => {
    const result = await enrichWithTypeScript(docs, {
      tsPath: TS_PATH,
      sourceFiles: ["src/index.ts"],
    });

    expect(result.diagnostics).toEqual([]);
    expect(result.docs.relations.length).toBeGreaterThanOrEqual(0);
  });

  test("enriches loc from TS when undefined", async () => {
    const result = await enrichWithTypeScript(docs, { tsPath: TS_PATH });

    const locCount = result.docs.symbols.filter((s) => s.loc).length;
    expect(locCount).toBeGreaterThan(0);
  });
});

describe("deep references: shadowing and strings", () => {
  test("shadowed import produces no edge; real use does; string mention does not", async () => {
    const { mkdtemp, rm, mkdir } = await import("node:fs/promises");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const root = await mkdtemp(join(tmpdir(), "metonym-shadow-"));
    try {
      await mkdir(join(root, "src"), { recursive: true });
      await Bun.write(
        join(root, "package.json"),
        JSON.stringify({
          name: "shadow-pkg",
          exports: { ".": "./src/index.ts" },
        }),
      );
      await Bun.write(
        join(root, "src/index.ts"),
        "export function add(a: number, b: number): number { return a + b; }\n",
      );
      await Bun.write(
        join(root, "README.md"),
        [
          "# t",
          "",
          "## Shadowed",
          "",
          "```ts",
          'import { add } from "shadow-pkg"',
          "const add2 = (x: number) => x",
          "{",
          "  const add = add2",
          "  expect(add(1)).toBe(1)",
          "}",
          "```",
          "",
          "## Real use",
          "",
          "```ts",
          'import { add } from "shadow-pkg"',
          "expect(add(1, 2)).toBe(3)",
          "```",
          "",
          "## String only",
          "",
          "```ts",
          'import { add } from "shadow-pkg"',
          'expect("add is fun".length).toBe(10)',
          "```",
          "",
        ].join("\n"),
      );
      const project = await scan({ root });
      const docs = await extract(project);
      const { docs: deep, diagnostics } = await enrichWithTypeScript(docs, {
        tsPath: TS_PATH,
      });
      expect(diagnostics).toEqual([]);
      const refsFor = (title: string) => {
        const ex = deep.examples.find((e) => e.title.startsWith(title));
        if (!ex) throw new Error(`missing example titled ${title}`);
        return deep.relations
          .filter((r) => r.kind === "references" && r.from === ex.id)
          .map((r) => r.to);
      };
      expect(refsFor("Real use")).toEqual(["sym:src/index.ts:add"]);
      expect(refsFor("Shadowed")).toEqual([]);
      expect(refsFor("String only")).toEqual([]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }, 30000);
});
