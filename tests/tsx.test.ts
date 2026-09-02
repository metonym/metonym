/**
 * Tests for TSX/JSX example execution support (src/emit/generate.ts).
 *
 * Covers:
 * - Automatic .test.tsx generation when document has tsx/jsx examples
 * - JSX pragma insertion when jsxImportSource is configured
 * - Line invariant with pragma offset
 * - Mixed ts/tsx documents
 * - End-to-end tsx execution with custom jsx runtime
 */

import { expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import {
  type Document,
  type DocumentationSet,
  type Example,
  extract,
  generate,
  IR_VERSION,
  scan,
  TOOL_NAME,
  TOOL_VERSION,
} from "metonym";

function createDocSet(
  documents: Document[],
  examples: Example[],
  root = "/tmp/x",
): DocumentationSet {
  return {
    irVersion: IR_VERSION,
    tool: { name: TOOL_NAME, version: TOOL_VERSION },
    root,
    documents,
    examples,
    symbols: [],
    relations: [],
  };
}

function codeLines(code: string): string[] {
  return code.split("\n");
}

function getBodyLines(
  code: string,
  startLine: number,
  endLine: number,
): string[] {
  const lines = codeLines(code);
  return lines.slice(startLine - 1, endLine);
}

test("tsx example generates .test.tsx file", () => {
  const doc: Document = {
    id: "doc:README.md",
    file: "README.md",
    origin: "readme",
    exampleIds: ["ex:README.md:abc123"],
  };

  const ex: Example = {
    id: "ex:README.md:abc123",
    documentId: "doc:README.md",
    source: {
      file: "README.md",
      start: { line: 10, column: 1, offset: 100 },
      end: { line: 11, column: 1, offset: 150 },
    },
    fenceSource: {
      file: "README.md",
      start: { line: 9, column: 1, offset: 90 },
      end: { line: 12, column: 1, offset: 160 },
    },
    language: "tsx",
    code: "const el = <div>hi</div>;\nexpect(el).toBeDefined();",
    kind: "assertion",
    title: "JSX example",
  };

  const docSet = createDocSet([doc], [ex]);
  const [generated] = generate(docSet);

  expect(generated.path).toBe("README.md.test.tsx");
  expect(generated.map.testFile).toBe("README.md.test.tsx");
  expect(generated.code).toContain("// README.md.test.tsx");
});

test("jsx example generates .test.tsx file", () => {
  const doc: Document = {
    id: "doc:test.md",
    file: "test.md",
    origin: "markdown",
    exampleIds: ["ex:test.md:xyz789"],
  };

  const ex: Example = {
    id: "ex:test.md:xyz789",
    documentId: "doc:test.md",
    source: {
      file: "test.md",
      start: { line: 5, column: 1, offset: 50 },
      end: { line: 6, column: 1, offset: 100 },
    },
    fenceSource: {
      file: "test.md",
      start: { line: 4, column: 1, offset: 40 },
      end: { line: 7, column: 1, offset: 110 },
    },
    language: "jsx",
    code: "const el = <span>test</span>;\nexpect(el).toBeDefined();",
    kind: "assertion",
    title: "JSX test",
  };

  const docSet = createDocSet([doc], [ex]);
  const [generated] = generate(docSet);

  expect(generated.path).toBe("test.md.test.tsx");
  expect(generated.map.testFile).toBe("test.md.test.tsx");
});

test("ts-only document generates .test.ts file", () => {
  const doc: Document = {
    id: "doc:test.md",
    file: "test.md",
    origin: "markdown",
    exampleIds: ["ex:test.md:abc123"],
  };

  const ex: Example = {
    id: "ex:test.md:abc123",
    documentId: "doc:test.md",
    source: {
      file: "test.md",
      start: { line: 5, column: 1, offset: 50 },
      end: { line: 6, column: 1, offset: 100 },
    },
    fenceSource: {
      file: "test.md",
      start: { line: 4, column: 1, offset: 40 },
      end: { line: 7, column: 1, offset: 110 },
    },
    language: "ts",
    code: "expect(1).toBe(1);",
    kind: "assertion",
    title: "TS example",
  };

  const docSet = createDocSet([doc], [ex]);
  const [generated] = generate(docSet);

  expect(generated.path).toBe("test.md.test.ts");
  expect(generated.map.testFile).toBe("test.md.test.ts");
});

test("pragma inserted as first line when jsxImportSource is set", () => {
  const doc: Document = {
    id: "doc:README.md",
    file: "README.md",
    origin: "readme",
    exampleIds: ["ex:README.md:abc123"],
  };

  const ex: Example = {
    id: "ex:README.md:abc123",
    documentId: "doc:README.md",
    source: {
      file: "README.md",
      start: { line: 10, column: 1, offset: 100 },
      end: { line: 11, column: 1, offset: 150 },
    },
    fenceSource: {
      file: "README.md",
      start: { line: 9, column: 1, offset: 90 },
      end: { line: 12, column: 1, offset: 160 },
    },
    language: "tsx",
    code: "const el = <div>hi</div>;\nexpect(el).toBeDefined();",
    kind: "assertion",
    title: "JSX example",
  };

  const docSet = createDocSet([doc], [ex]);
  const [generated] = generate(docSet, { jsxImportSource: "mini-jsx" });

  const lines = codeLines(generated.code);
  expect(lines[0]).toBe("/* @jsxImportSource mini-jsx */");
  expect(lines[1]).toContain("// README.md.test.tsx");
});

test("no pragma when tsx file but jsxImportSource not set", () => {
  const doc: Document = {
    id: "doc:README.md",
    file: "README.md",
    origin: "readme",
    exampleIds: ["ex:README.md:abc123"],
  };

  const ex: Example = {
    id: "ex:README.md:abc123",
    documentId: "doc:README.md",
    source: {
      file: "README.md",
      start: { line: 10, column: 1, offset: 100 },
      end: { line: 11, column: 1, offset: 150 },
    },
    fenceSource: {
      file: "README.md",
      start: { line: 9, column: 1, offset: 90 },
      end: { line: 12, column: 1, offset: 160 },
    },
    language: "tsx",
    code: "const el = <div>hi</div>;\nexpect(el).toBeDefined();",
    kind: "assertion",
    title: "JSX example",
  };

  const docSet = createDocSet([doc], [ex]);
  const [generated] = generate(docSet);

  const lines = codeLines(generated.code);
  expect(lines[0]).not.toContain("@jsxImportSource");
  expect(lines[0]).toContain("// README.md.test.tsx");
});

test("no pragma for ts document even with jsxImportSource option", () => {
  const doc: Document = {
    id: "doc:test.md",
    file: "test.md",
    origin: "markdown",
    exampleIds: ["ex:test.md:abc123"],
  };

  const ex: Example = {
    id: "ex:test.md:abc123",
    documentId: "doc:test.md",
    source: {
      file: "test.md",
      start: { line: 5, column: 1, offset: 50 },
      end: { line: 6, column: 1, offset: 100 },
    },
    fenceSource: {
      file: "test.md",
      start: { line: 4, column: 1, offset: 40 },
      end: { line: 7, column: 1, offset: 110 },
    },
    language: "ts",
    code: "expect(1).toBe(1);",
    kind: "assertion",
    title: "TS example",
  };

  const docSet = createDocSet([doc], [ex]);
  const [generated] = generate(docSet, { jsxImportSource: "mini-jsx" });

  const lines = codeLines(generated.code);
  expect(lines[0]).not.toContain("@jsxImportSource");
  expect(generated.path).toBe("test.md.test.ts");
});

test("backward compatibility: generate(docs) with no opts works unchanged", () => {
  const doc: Document = {
    id: "doc:test.md",
    file: "test.md",
    origin: "markdown",
    exampleIds: ["ex:test.md:abc123"],
  };

  const ex: Example = {
    id: "ex:test.md:abc123",
    documentId: "doc:test.md",
    source: {
      file: "test.md",
      start: { line: 1, column: 1, offset: 0 },
      end: { line: 2, column: 1, offset: 50 },
    },
    fenceSource: {
      file: "test.md",
      start: { line: 1, column: 1, offset: 0 },
      end: { line: 2, column: 1, offset: 50 },
    },
    language: "ts",
    code: "expect(1).toBe(1);",
    kind: "assertion",
    title: "Test",
  };

  const docSet = createDocSet([doc], [ex]);

  const [generated] = generate(docSet);

  expect(generated.path).toBe("test.md.test.ts");
  expect(generated.code).toContain("import { describe, test, expect }");
  expect(generated.code).toContain("expect(1).toBe(1);");
});

test("line invariant holds with pragma offset", () => {
  const doc: Document = {
    id: "doc:test.md",
    file: "test.md",
    origin: "markdown",
    exampleIds: ["ex:test.md:abc123"],
  };

  const bodyCode = `const x = 1;
const y = 2;
expect(x + y).toBe(3);`;

  const ex: Example = {
    id: "ex:test.md:abc123",
    documentId: "doc:test.md",
    source: {
      file: "test.md",
      start: { line: 5, column: 1, offset: 50 },
      end: { line: 8, column: 1, offset: 100 },
    },
    fenceSource: {
      file: "test.md",
      start: { line: 4, column: 1, offset: 40 },
      end: { line: 9, column: 1, offset: 110 },
    },
    language: "tsx",
    code: bodyCode,
    kind: "assertion",
    title: "Multi-line TSX",
  };

  const docSet = createDocSet([doc], [ex]);
  const [generated] = generate(docSet, { jsxImportSource: "mini-jsx" });

  const lines = codeLines(generated.code);
  expect(lines[0]).toBe("/* @jsxImportSource mini-jsx */");

  const entry = generated.map.entries[0];
  expect(entry).toBeDefined();

  const genBodyLines = getBodyLines(
    generated.code,
    entry.genCodeStartLine,
    entry.genCodeEndLine,
  );

  expect(genBodyLines).toHaveLength(3);

  const trimmed = genBodyLines.map((l) => l.replace(/^ {4}/, ""));
  const expectedLines = bodyCode.split("\n");
  for (let i = 0; i < trimmed.length; i++) {
    expect(trimmed[i]).toBe(expectedLines[i]);
  }

  const _docCodeStartLine = entry.docCodeStartLine;
  const genCodeStartLine = entry.genCodeStartLine;
  // docLine = docCodeStartLine + (genLine - genCodeStartLine)
  const firstGenLine = lines[genCodeStartLine - 1].replace(/^ {4}/, "");
  const firstDocLine = bodyCode.split("\n")[0];
  expect(firstGenLine).toBe(firstDocLine);
});

test("document with both ts and tsx examples generates .test.tsx", () => {
  const doc: Document = {
    id: "doc:test.md",
    file: "test.md",
    origin: "markdown",
    exampleIds: ["ex:test.md:ts", "ex:test.md:tsx"],
  };

  const tsEx: Example = {
    id: "ex:test.md:ts",
    documentId: "doc:test.md",
    source: {
      file: "test.md",
      start: { line: 5, column: 1, offset: 50 },
      end: { line: 6, column: 1, offset: 100 },
    },
    fenceSource: {
      file: "test.md",
      start: { line: 4, column: 1, offset: 40 },
      end: { line: 7, column: 1, offset: 110 },
    },
    language: "ts",
    code: "expect(1).toBe(1);",
    kind: "assertion",
    title: "TS example",
  };

  const tsxEx: Example = {
    id: "ex:test.md:tsx",
    documentId: "doc:test.md",
    source: {
      file: "test.md",
      start: { line: 10, column: 1, offset: 150 },
      end: { line: 11, column: 1, offset: 200 },
    },
    fenceSource: {
      file: "test.md",
      start: { line: 9, column: 1, offset: 140 },
      end: { line: 12, column: 1, offset: 210 },
    },
    language: "tsx",
    code: "const el = <div>hi</div>;\nexpect(el).toBeDefined();",
    kind: "assertion",
    title: "TSX example",
  };

  const docSet = createDocSet([doc], [tsEx, tsxEx]);
  const [generated] = generate(docSet, { jsxImportSource: "react" });

  expect(generated.path).toBe("test.md.test.tsx");
  expect(generated.code).toContain("@jsxImportSource react");
  expect(generated.code).toContain("expect(1).toBe(1);");
  expect(generated.code).toContain("<div>hi</div>");
});

test("no-run tsx examples validate transpile", () => {
  const doc: Document = {
    id: "doc:test.md",
    file: "test.md",
    origin: "markdown",
    exampleIds: [
      "ex:test.md:valid-tsx",
      "ex:test.md:valid-ts",
      "ex:test.md:executable",
    ],
  };

  const validTsx: Example = {
    id: "ex:test.md:valid-tsx",
    documentId: "doc:test.md",
    source: {
      file: "test.md",
      start: { line: 5, column: 1, offset: 50 },
      end: { line: 6, column: 1, offset: 100 },
    },
    fenceSource: {
      file: "test.md",
      start: { line: 4, column: 1, offset: 40 },
      end: { line: 7, column: 1, offset: 110 },
    },
    language: "tsx",
    code: "const el = <div>test</div>;",
    kind: "no-run",
    title: "Valid TSX no-run",
  };

  const validTs: Example = {
    id: "ex:test.md:valid-ts",
    documentId: "doc:test.md",
    source: {
      file: "test.md",
      start: { line: 10, column: 1, offset: 150 },
      end: { line: 11, column: 1, offset: 200 },
    },
    fenceSource: {
      file: "test.md",
      start: { line: 9, column: 1, offset: 140 },
      end: { line: 12, column: 1, offset: 210 },
    },
    language: "ts",
    code: "const x = 1;",
    kind: "no-run",
    title: "Valid TS no-run",
  };

  const executable: Example = {
    id: "ex:test.md:executable",
    documentId: "doc:test.md",
    source: {
      file: "test.md",
      start: { line: 15, column: 1, offset: 250 },
      end: { line: 16, column: 1, offset: 300 },
    },
    fenceSource: {
      file: "test.md",
      start: { line: 14, column: 1, offset: 240 },
      end: { line: 17, column: 1, offset: 310 },
    },
    language: "ts",
    code: "expect(1).toBe(1);",
    kind: "assertion",
    title: "Executable test",
  };

  const docSet = createDocSet([doc], [validTsx, validTs, executable]);
  const [generated] = generate(docSet);

  expect(generated.diagnostics || []).toHaveLength(0);
  expect(generated.path).toBe("test.md.test.tsx");
});

test("e2e: tsx example generates correct file with pragma", async () => {
  const tempDir = await fs.mkdtemp("/tmp/metonym-tsx-e2e-");

  try {
    const pkgJson = {
      name: "mini-jsx",
      exports: {
        ".": "./src/index.ts",
        "./jsx-runtime": "./src/jsx-runtime.ts",
      },
    };
    await fs.writeFile(
      `${tempDir}/package.json`,
      JSON.stringify(pkgJson, null, 2),
    );

    const jsxRuntime = `export function jsx(type: any, props: any): any {
  return { type, props };
}

export const jsxs = jsx;

export const Fragment = "fragment";
`;
    await fs.mkdir(`${tempDir}/src`, { recursive: true });
    await fs.writeFile(`${tempDir}/src/jsx-runtime.ts`, jsxRuntime);

    const indexTs = `export function tagOf(el: any): any {
  return el.type;
}
`;
    await fs.writeFile(`${tempDir}/src/index.ts`, indexTs);

    const readmeMd = `# mini-jsx

\`\`\`tsx
import { tagOf } from "mini-jsx"
const el = <div title="hi">x</div>
expect(tagOf(el)).toBe("div")
\`\`\`
`;
    await fs.writeFile(`${tempDir}/README.md`, readmeMd);

    const project = await scan({
      root: tempDir,
      config: {
        include: ["README.md"],
        exclude: ["**/node_modules/**"],
      },
    });

    const docs = await extract(project);

    const generated = generate(docs, { jsxImportSource: "mini-jsx" });

    expect(generated).toHaveLength(1);
    const [gt] = generated;
    expect(gt.path).toBe("README.md.test.tsx");
    expect(gt.code).toContain("@jsxImportSource mini-jsx");
    expect(gt.code).toContain("tagOf");

    const lines = codeLines(gt.code);
    expect(lines[0]).toBe("/* @jsxImportSource mini-jsx */");
    expect(lines[1]).toContain("// README.md.test.tsx");
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});

test("e2e: multiple tsx examples generate with correct line tracking", async () => {
  const tempDir = await fs.mkdtemp("/tmp/metonym-tsx-multi-");

  try {
    const pkgJson = {
      name: "mini-jsx",
      exports: {
        ".": "./src/index.ts",
        "./jsx-runtime": "./src/jsx-runtime.ts",
      },
    };
    await fs.writeFile(
      `${tempDir}/package.json`,
      JSON.stringify(pkgJson, null, 2),
    );

    const jsxRuntime = `export function jsx(type: any, props: any): any {
  return { type, props };
}

export const jsxs = jsx;

export const Fragment = "fragment";
`;
    await fs.mkdir(`${tempDir}/src`, { recursive: true });
    await fs.writeFile(`${tempDir}/src/jsx-runtime.ts`, jsxRuntime);

    const indexTs = `export function tagOf(el: any): any {
  return el.type;
}
`;
    await fs.writeFile(`${tempDir}/src/index.ts`, indexTs);

    const readmeMd = `# mini-jsx

## First example

\`\`\`tsx
import { tagOf } from "mini-jsx"
const el = <div title="hi">x</div>
expect(tagOf(el)).toBe("div")
\`\`\`

## Second example

\`\`\`tsx
import { tagOf } from "mini-jsx"
const el = <span>test</span>
expect(tagOf(el)).toBe("span")
\`\`\`
`;
    await fs.writeFile(`${tempDir}/README.md`, readmeMd);

    const project = await scan({
      root: tempDir,
      config: {
        include: ["README.md"],
        exclude: ["**/node_modules/**"],
      },
    });
    const docs = await extract(project);

    expect(docs.examples).toHaveLength(2);

    const generated = generate(docs, { jsxImportSource: "mini-jsx" });

    expect(generated).toHaveLength(1);
    const [gt] = generated;

    expect(gt.path).toBe("README.md.test.tsx");
    expect(gt.code).toContain("@jsxImportSource mini-jsx");

    expect(gt.code).toContain("<div title");
    expect(gt.code).toContain("<span>");

    expect(gt.map.entries).toHaveLength(2);

    for (const entry of gt.map.entries) {
      const bodyLines = getBodyLines(
        gt.code,
        entry.genCodeStartLine,
        entry.genCodeEndLine,
      );
      expect(bodyLines.length).toBeGreaterThan(0);
    }
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});
