import { expect, test } from "bun:test";
import { tmpdir } from "node:os";
import { extract } from "metonym";
import { exampleReferences, exercisedSymbols } from "../src/graph/references";
import { parseImportBindings } from "../src/parse/imports";

test("parseImportBindings: simple default import", () => {
  const code = `import add from "math"`;
  const bindings = parseImportBindings(code);
  expect(bindings).toEqual([
    { local: "add", imported: "default", specifier: "math" },
  ]);
});

test("parseImportBindings: default import with semicolon", () => {
  const code = `import add from "math";`;
  const bindings = parseImportBindings(code);
  expect(bindings).toEqual([
    { local: "add", imported: "default", specifier: "math" },
  ]);
});

test("parseImportBindings: named imports", () => {
  const code = `import { a, b } from "mod"`;
  const bindings = parseImportBindings(code);
  expect(bindings).toEqual([
    { local: "a", imported: "a", specifier: "mod" },
    { local: "b", imported: "b", specifier: "mod" },
  ]);
});

test("parseImportBindings: named imports with renaming", () => {
  const code = `import { a as x, b as y } from "mod"`;
  const bindings = parseImportBindings(code);
  expect(bindings).toEqual([
    { local: "x", imported: "a", specifier: "mod" },
    { local: "y", imported: "b", specifier: "mod" },
  ]);
});

test("parseImportBindings: namespace import", () => {
  const code = `import * as math from "math"`;
  const bindings = parseImportBindings(code);
  expect(bindings).toEqual([
    { local: "math", imported: "*", specifier: "math" },
  ]);
});

test("parseImportBindings: mixed default and named", () => {
  const code = `import add, { multiply } from "math"`;
  const bindings = parseImportBindings(code);
  expect(bindings).toEqual([
    { local: "add", imported: "default", specifier: "math" },
    { local: "multiply", imported: "multiply", specifier: "math" },
  ]);
});

test("parseImportBindings: skip type-only import", () => {
  const code = `import type { A } from "types"`;
  const bindings = parseImportBindings(code);
  expect(bindings).toEqual([]);
});

test("parseImportBindings: skip type specifiers in named imports", () => {
  const code = `import { type A, b } from "mod"`;
  const bindings = parseImportBindings(code);
  expect(bindings).toEqual([{ local: "b", imported: "b", specifier: "mod" }]);
});

test("parseImportBindings: inline type specifiers", () => {
  const code = `import { type A, b, type C, d as e } from "mod"`;
  const bindings = parseImportBindings(code);
  expect(bindings).toEqual([
    { local: "b", imported: "b", specifier: "mod" },
    { local: "e", imported: "d", specifier: "mod" },
  ]);
});

test("parseImportBindings: side-effect import has no bindings", () => {
  const code = `import "setup"`;
  const bindings = parseImportBindings(code);
  expect(bindings).toEqual([]);
});

test("parseImportBindings: multiple imports in one code string", () => {
  const code = `
import x from "a"
import { b } from "c"
import * as d from "e"
`;
  const bindings = parseImportBindings(code);
  expect(bindings).toEqual([
    { local: "x", imported: "default", specifier: "a" },
    { local: "b", imported: "b", specifier: "c" },
    { local: "d", imported: "*", specifier: "e" },
  ]);
});

test("exampleReferences: fixture project with re-exports and usage checking", async () => {
  const tmpDir = (await Bun.file(tmpdir()).exists()) ? tmpdir() : "/tmp";
  const fixtureRoot = (await Bun.file(
    `${tmpDir}/metonym-ref-pkg-${Date.now()}`,
  ).exists())
    ? `${tmpDir}/metonym-ref-pkg-${Date.now()}-${Math.random()}`
    : `${tmpDir}/metonym-ref-pkg-${Date.now()}`;

  await Bun.write(`${fixtureRoot}/.created`, "");
  Bun.file(`${fixtureRoot}/package.json`);
  Bun.file(`${fixtureRoot}/src/util.ts`);
  Bun.file(`${fixtureRoot}/src/index.ts`);
  Bun.file(`${fixtureRoot}/README.md`);

  await Bun.write(
    `${fixtureRoot}/package.json`,
    JSON.stringify({
      name: "ref-pkg",
      exports: {
        ".": "./src/index.ts",
      },
    }),
  );

  await Bun.write(
    `${fixtureRoot}/src/util.ts`,
    `export function helper() { return 1 }`,
  );

  await Bun.write(
    `${fixtureRoot}/src/index.ts`,
    `export function add(a: number, b: number) { return a + b }
export function unused() { }
export { helper } from "./util";`,
  );

  await Bun.write(
    `${fixtureRoot}/README.md`,
    `# Test Package

\`\`\`ts
import { add } from "ref-pkg"
expect(add(2, 3)).toBe(5)
\`\`\`

\`\`\`ts
import { add, unused } from "ref-pkg"
expect(add(1, 2)).toBe(3)
\`\`\`

\`\`\`ts
import { helper } from "ref-pkg"
expect(helper()).toBe(1)
\`\`\`

\`\`\`ts
import * as pkg from "ref-pkg"
expect(pkg.add(1, 2)).toBe(3)
\`\`\`
`,
  );

  try {
    const docs = await extract({
      root: fixtureRoot,
      config: {
        root: fixtureRoot,
        include: ["README.md"],
        exclude: ["**/node_modules/**"],
        outDir: ".metonym/tests",
        languages: ["ts", "tsx", "js", "jsx"],
        inject: true,
      },
      docFiles: ["README.md"],
      sourceFiles: ["src/util.ts", "src/index.ts"],
    });

    const refs = exampleReferences(docs);

    const refRelations = refs.filter((r) => r.kind === "references");

    const addSym = docs.symbols.find((s) => s.name === "add");
    const unusedSym = docs.symbols.find((s) => s.name === "unused");
    const helperSym = docs.symbols.find((s) => s.name === "helper");

    expect(addSym).toBeDefined();
    expect(helperSym).toBeDefined();
    expect(unusedSym).toBeDefined();
    if (!addSym || !helperSym || !unusedSym) {
      throw new Error("expected add, helper, and unused symbols");
    }

    expect(docs.examples.length).toBe(4);

    const [ex1, ex2, ex3, ex4] = docs.examples;

    // Example 1: import { add } and use it → edge to add
    const ex1Refs = refRelations.filter((r) => r.from === ex1.id);
    expect(ex1Refs.length).toBe(1);
    expect(ex1Refs[0].to).toBe(addSym.id);

    // Example 2: import { add, unused } but only use add → edge to add only
    const ex2Refs = refRelations.filter((r) => r.from === ex2.id);
    expect(ex2Refs.length).toBe(1);
    expect(ex2Refs[0].to).toBe(addSym.id);

    // Example 3: import { helper } → edges to both index.ts:helper (re-export) and util.ts:helper
    const ex3Refs = refRelations.filter((r) => r.from === ex3.id);
    expect(ex3Refs.length).toBe(2);
    const ex3To = ex3Refs.map((r) => r.to).sort();
    const helperSymbols = [
      docs.symbols.find((s) => s.file === "src/index.ts" && s.name === "helper")
        ?.id,
      docs.symbols.find((s) => s.file === "src/util.ts" && s.name === "helper")
        ?.id,
    ]
      .filter((id): id is string => id !== undefined)
      .sort();
    expect(ex3To).toEqual(helperSymbols);

    // Example 4: import * as pkg and use pkg.add → edge to add
    const ex4Refs = refRelations.filter((r) => r.from === ex4.id);
    expect(ex4Refs.length).toBe(1);
    expect(ex4Refs[0].to).toBe(addSym.id);

    const exercised = exercisedSymbols(docs);
    expect(exercised.has(addSym.id)).toBe(true);
    expect(exercised.has(helperSym.id)).toBe(true);
    expect(exercised.has(unusedSym.id)).toBe(false);

    const refs2 = exampleReferences(docs);
    const refRels2 = refs2.filter((r) => r.kind === "references");
    expect(refRels2).toEqual(refRelations);

    const exercised2 = exercisedSymbols(docs);
    expect(Array.from(exercised2).sort()).toEqual(Array.from(exercised).sort());
  } finally {
    try {
      await Bun.write(`${fixtureRoot}/.cleanup`, "");
    } catch {}
  }
});
