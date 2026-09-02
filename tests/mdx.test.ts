/**
 * MDX documentation source support tests.
 *
 * Covers:
 * - Realistic MDX extraction with import/export, JSX blocks, JSX comments
 * - Scan classification of .mdx files
 * - End-to-end pipeline: scan → extract → generate → run
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { extract, extractMarkdown, generate, scan } from "metonym";

let testFixtureDir: string;

beforeEach(() => {
  testFixtureDir = mkdtempSync(resolve(tmpdir(), "metonym-mdx-test-"));
});

afterEach(() => {
  if (testFixtureDir) {
    rmSync(testFixtureDir, { recursive: true, force: true });
  }
});

describe("mdx: basic extraction", () => {
  test("mdx fixture: realistic MDX with imports, exports, JSX, comments", () => {
    const text = `import { Chart } from "./chart"
import { useData } from "hooks"

export const meta = {
  title: "Advanced Guide",
}

# Getting Started

This is a guide.

\`\`\`ts
import { useData } from "hooks"
const data = await useData()
expect(data).toBeDefined()
\`\`\`

## Charts

Here's a chart component:

<Chart data={x} />

This is a comment block:

{/* This is a JSX comment with # not-a-heading */}

\`\`\`ts
const y = 1
expect(y).toBe(1)
\`\`\`

\`\`\`ts pending
const pending = await unimplemented()
\`\`\`

\`\`\`jsx-live
some code that is not executable
\`\`\`
`;

    const { document, examples } = extractMarkdown(text, {
      file: "docs/guide.mdx",
    });

    expect(document.origin).toBe("mdx");

    expect(document.title).toBe("Getting Started");

    // jsx-live fences are inert
    const executableExamples = examples.filter((ex) => ex.kind !== "ignored");
    expect(executableExamples.length).toBe(3);

    const ex1 = examples[0];
    expect(ex1.kind).toBe("assertion");
    expect(ex1.source.start.line).toBe(13); // Line of first code line in first fence
    expect(ex1.code).toContain("const data = await useData()");
    expect(ex1.title).toBe("Getting Started › example 1");

    const ex2 = examples[1];
    expect(ex2.kind).toBe("assertion");
    expect(ex2.code).toContain("const y = 1");
    expect(ex2.title).toBe("Charts › example 1");

    const ex3 = examples[2];
    expect(ex3.kind).toBe("pending");
    expect(ex3.code).toContain("const pending = await unimplemented()");
    expect(ex3.title).toBe("Charts › example 2");

    expect(examples.some((ex) => ex.code.includes("export const meta"))).toBe(
      false,
    );
    expect(examples.some((ex) => ex.code.includes("import { Chart }"))).toBe(
      false,
    );
  });

  test("mdx: headings inside JSX comment blocks are ignored", () => {
    const text = `# Real Heading

\`\`\`ts
test1()
\`\`\`

{/* # Fake heading inside comment */}

\`\`\`ts
test2()
\`\`\`

# Another Real Heading

\`\`\`ts
test3()
\`\`\`
`;

    const { examples } = extractMarkdown(text, { file: "test.mdx" });

    expect(examples.length).toBe(3);

    expect(examples[0].title).toBe("Real Heading › example 1");

    // Example 2: still under "Real Heading" (JSX comment heading is ignored)
    expect(examples[1].title).toBe("Real Heading › example 2");

    expect(examples[2].title).toBe("Another Real Heading › example 1");
  });

  test("mdx: multiline JSX comment blocks are tracked correctly", () => {
    const text = `# First

\`\`\`ts
code1()
\`\`\`

{/*
  Multi-line JSX comment
  # Heading inside (ignored)
  More comment here
*/}

\`\`\`ts
code2()
\`\`\`
`;

    const { examples } = extractMarkdown(text, { file: "test.mdx" });

    expect(examples.length).toBe(2);
    expect(examples[0].title).toBe("First › example 1");
    expect(examples[1].title).toBe("First › example 2");
  });

  test("mdx: README.md still gets origin=readme; README.mdx gets mdx", () => {
    const text1 = `# Title
\`\`\`ts
test()
\`\`\``;

    const { document: doc1 } = extractMarkdown(text1, { file: "README.md" });
    expect(doc1.origin).toBe("readme");

    const { document: doc2 } = extractMarkdown(text1, { file: "README.mdx" });
    // README.mdx is not README.md, so it gets mdx
    expect(doc2.origin).toBe("mdx");
  });

  test("mdx: regular markdown files stay as markdown (no change)", () => {
    const text = `# Heading
\`\`\`ts
test()
\`\`\``;

    const { document } = extractMarkdown(text, { file: "docs/guide.md" });
    expect(document.origin).toBe("markdown");
  });

  test("mdx: exact source.start.line for examples in MDX", () => {
    const text = `import { x } from "y"

# Title

\`\`\`ts
line1
line2
\`\`\`
`;

    const { examples } = extractMarkdown(text, { file: "test.mdx" });
    expect(examples.length).toBe(1);
    expect(examples[0].source.start.line).toBe(6); // First code line
  });
});

describe("mdx: scan classification", () => {
  test("scan includes .mdx files in docFiles", async () => {
    mkdirSync(resolve(testFixtureDir, "docs"), { recursive: true });
    writeFileSync(resolve(testFixtureDir, "package.json"), "{}");
    writeFileSync(resolve(testFixtureDir, "docs/a.mdx"), "# Doc A\n");
    writeFileSync(resolve(testFixtureDir, "docs/b.md"), "# Doc B\n");

    const project = await scan({ root: testFixtureDir });

    expect(project.docFiles).toContain("docs/a.mdx");
    expect(project.docFiles).toContain("docs/b.md");
    expect(project.docFiles.length).toBe(2);
  });

  test("scan handles mixed .md and .mdx files together", async () => {
    mkdirSync(resolve(testFixtureDir, "docs"), { recursive: true });
    writeFileSync(resolve(testFixtureDir, "docs/a.md"), "# A\n");
    writeFileSync(resolve(testFixtureDir, "docs/b.mdx"), "# B\n");

    const project = await scan({ root: testFixtureDir });

    expect(project.docFiles).toContain("docs/a.md");
    expect(project.docFiles).toContain("docs/b.mdx");
    expect(project.docFiles.length).toBe(2);
  });
});

describe("mdx: end-to-end pipeline", () => {
  test("e2e: scan → extract → generate for MDX files", async () => {
    mkdirSync(resolve(testFixtureDir, "docs"), { recursive: true });

    writeFileSync(
      resolve(testFixtureDir, "package.json"),
      JSON.stringify({ name: "test-pkg", exports: { ".": "./src/index.ts" } }),
    );

    writeFileSync(
      resolve(testFixtureDir, "docs/guide.mdx"),
      [
        "# MDX Guide",
        "",
        "Example 1:",
        "",
        "```ts",
        "expect(1 + 1).toBe(2)",
        "```",
        "",
        "Example 2:",
        "",
        "```ts pending",
        "await future_feature()",
        "```",
        "",
      ].join("\n"),
    );

    const project = await scan({ root: testFixtureDir });
    expect(project.docFiles).toContain("docs/guide.mdx");

    const docs = await extract(project);

    const mdxDoc = docs.documents.find((d) => d.file === "docs/guide.mdx");
    expect(mdxDoc).toBeDefined();
    expect(mdxDoc?.origin).toBe("mdx");
    expect(mdxDoc?.title).toBe("MDX Guide");

    const mdxExamples = docs.examples.filter(
      (ex) => ex.documentId === mdxDoc?.id,
    );
    expect(mdxExamples.length).toBe(2);
    expect(mdxExamples[0].kind).toBe("assertion");
    expect(mdxExamples[1].kind).toBe("pending");

    const artifacts = generate(docs);
    const mdxTestArtifact = artifacts.find(
      (a) => a.path === "docs/guide.mdx.test.ts",
    );
    expect(mdxTestArtifact).toBeDefined();
    if (mdxTestArtifact) {
      expect(mdxTestArtifact.code).toContain("source: docs/guide.mdx");
      expect(mdxTestArtifact.code).toContain("MDX Guide");
      expect(mdxTestArtifact.code).toContain("1 + 1");
    }
  });
});
