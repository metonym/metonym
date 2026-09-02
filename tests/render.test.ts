/**
 * Renderer tests for markdown, html, json, jsonl.
 * Create a temp fixture, run through the pipeline, assert output.
 */

import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { type ExampleResult, extract, type RunResult, scan } from "metonym";
import { renderers } from "../src/render/index";

function createTestDir(): string {
  return mkdtempSync("/tmp/metonym-render-test-");
}

function cleanupDir(dir: string) {
  rmSync(dir, { recursive: true, force: true });
}

async function createFixture(): Promise<string> {
  const tmpDir = createTestDir();

  await Bun.write(
    `${tmpDir}/package.json`,
    JSON.stringify({ name: "test-pkg" }),
  );

  const readmeContent = `# Test Project

## Quick Start

Here's an example:

\`\`\`ts
expect(2 + 2).toBe(4)
\`\`\`

## Advanced

This is a pending feature:

\`\`\`ts pending
await future.api()
\`\`\`
`;

  await Bun.write(`${tmpDir}/README.md`, readmeContent);

  return tmpDir;
}

function createFakeRunResult(exampleIds: string[]): RunResult {
  const results: ExampleResult[] = [
    {
      exampleId: exampleIds[0],
      title: "Test › example 1",
      docFile: "README.md",
      status: "passed",
      durationMs: 5,
    },
    {
      exampleId: exampleIds[1],
      title: "Advanced › example 1",
      docFile: "README.md",
      status: "pending",
      durationMs: 0,
    },
  ];

  return {
    results,
    totals: {
      total: 2,
      passed: 1,
      failed: 0,
      pending: 1,
      skipped: 0,
      durationMs: 5,
    },
    outDir: ".metonym/tests",
    exitCode: 0,
  };
}

describe("markdown renderer", () => {
  test("emits annotated markdown with header and status lines", async () => {
    const tmpDir = await createFixture();

    try {
      const project = await scan({ root: tmpDir });
      const docs = await extract(project);
      const runResult = createFakeRunResult(docs.examples.map((e) => e.id));

      const result = await renderers.markdown.render(docs, {
        results: runResult,
      });

      expect(result.files.length).toBe(1);
      expect(result.files[0].path).toBe("README.md");

      const content = result.files[0].contents;

      expect(content).toContain("verified by metonym v");
      expect(content).toContain("2 examples: 1 passed · 0 failed · 1 pending");

      expect(content).toContain("✓ passed");
      expect(content).toContain("○ pending");

      expect(content).toContain("# Test Project");
      expect(content).toContain("expect(2 + 2).toBe(4)");
    } finally {
      cleanupDir(tmpDir);
    }
  });

  test("preserves original markdown when no results provided", async () => {
    const tmpDir = await createFixture();

    try {
      const project = await scan({ root: tmpDir });
      const docs = await extract(project);

      const result = await renderers.markdown.render(docs, {});

      const content = result.files[0].contents;

      expect(content).toContain("extracted by metonym v");
      expect(content).toContain("2 examples");

      expect(content).toContain("· not run");
    } finally {
      cleanupDir(tmpDir);
    }
  });

  test("emits deterministic output on repeated renders", async () => {
    const tmpDir = await createFixture();

    try {
      const project = await scan({ root: tmpDir });
      const docs = await extract(project);
      const runResult = createFakeRunResult(docs.examples.map((e) => e.id));

      const result1 = await renderers.markdown.render(docs, {
        results: runResult,
      });
      const result2 = await renderers.markdown.render(docs, {
        results: runResult,
      });

      expect(result1.files[0].contents).toBe(result2.files[0].contents);
    } finally {
      cleanupDir(tmpDir);
    }
  });
});

describe("html renderer", () => {
  test("emits HTML with doctype and body", async () => {
    const tmpDir = await createFixture();

    try {
      const project = await scan({ root: tmpDir });
      const docs = await extract(project);
      const runResult = createFakeRunResult(docs.examples.map((e) => e.id));

      const result = await renderers.html.render(docs, { results: runResult });

      const htmlFile = result.files.find((f) => f.path === "README.md.html");
      expect(htmlFile).toBeDefined();

      const content = htmlFile?.contents;

      expect(content).toContain("<!doctype html>");
      expect(content).toContain("<html>");
      expect(content).toContain("</html>");
      expect(content).toContain("<meta charset");
      expect(content).toContain("<title>README.md</title>");

      expect(content).toContain("<h1>Test Project</h1>");
      expect(content).toContain("Test Project");

      expect(content).toContain("font-family");
      expect(content).toContain("max-width");
    } finally {
      cleanupDir(tmpDir);
    }
  });

  test("wraps body content in main element", async () => {
    const tmpDir = await createFixture();

    try {
      const project = await scan({ root: tmpDir });
      const docs = await extract(project);

      const result = await renderers.html.render(docs, {});

      const htmlFile = result.files.find((f) => f.path === "README.md.html");
      const content = htmlFile?.contents;

      expect(content).toContain("<main>");
      expect(content).toContain("</main>");
    } finally {
      cleanupDir(tmpDir);
    }
  });

  test("produces deterministic output", async () => {
    const tmpDir = await createFixture();

    try {
      const project = await scan({ root: tmpDir });
      const docs = await extract(project);
      const runResult = createFakeRunResult(docs.examples.map((e) => e.id));

      const result1 = await renderers.html.render(docs, { results: runResult });
      const result2 = await renderers.html.render(docs, { results: runResult });

      const file1 = result1.files.find((f) => f.path === "README.md.html");
      const file2 = result2.files.find((f) => f.path === "README.md.html");

      expect(file1?.contents).toBe(file2?.contents);
    } finally {
      cleanupDir(tmpDir);
    }
  });
});

describe("json renderer", () => {
  test("emits metonym.ir.json with root replaced by dot", async () => {
    const tmpDir = await createFixture();

    try {
      const project = await scan({ root: tmpDir });
      const docs = await extract(project);

      const result = await renderers.json.render(docs, {});

      expect(result.files.length).toBe(1);
      expect(result.files[0].path).toBe("metonym.ir.json");

      const jsonData = JSON.parse(result.files[0].contents);

      expect(jsonData.root).toBe(".");

      expect(jsonData.irVersion).toBeDefined();
      expect(jsonData.tool.name).toBe("metonym");
      expect(Array.isArray(jsonData.documents)).toBe(true);
      expect(Array.isArray(jsonData.examples)).toBe(true);
      expect(Array.isArray(jsonData.symbols)).toBe(true);
      expect(Array.isArray(jsonData.relations)).toBe(true);
    } finally {
      cleanupDir(tmpDir);
    }
  });

  test("embeds results when provided", async () => {
    const tmpDir = await createFixture();

    try {
      const project = await scan({ root: tmpDir });
      const docs = await extract(project);
      const runResult = createFakeRunResult(docs.examples.map((e) => e.id));

      const result = await renderers.json.render(docs, { results: runResult });

      const jsonData = JSON.parse(result.files[0].contents);

      expect(jsonData.results).toBeDefined();
      expect(Array.isArray(jsonData.results.results)).toBe(true);
      expect(jsonData.results.results.length).toBe(2);
    } finally {
      cleanupDir(tmpDir);
    }
  });

  test("sets results to null when not provided", async () => {
    const tmpDir = await createFixture();

    try {
      const project = await scan({ root: tmpDir });
      const docs = await extract(project);

      const result = await renderers.json.render(docs, {});

      const jsonData = JSON.parse(result.files[0].contents);
      expect(jsonData.results).toBeNull();
    } finally {
      cleanupDir(tmpDir);
    }
  });

  test("output is valid JSON and parses cleanly", async () => {
    const tmpDir = await createFixture();

    try {
      const project = await scan({ root: tmpDir });
      const docs = await extract(project);

      const result = await renderers.json.render(docs, {});
      const content = result.files[0].contents;

      const parsed = JSON.parse(content);
      expect(parsed).toBeDefined();

      expect(content).toMatch(/\n$/);
    } finally {
      cleanupDir(tmpDir);
    }
  });
});

describe("jsonl renderer", () => {
  test("emits metonym.examples.jsonl with one line per example", async () => {
    const tmpDir = await createFixture();

    try {
      const project = await scan({ root: tmpDir });
      const docs = await extract(project);

      const result = await renderers.jsonl.render(docs, {});

      expect(result.files.length).toBe(1);
      expect(result.files[0].path).toBe("metonym.examples.jsonl");

      const lines = result.files[0].contents.trim().split("\n");

      expect(lines.length).toBe(docs.examples.length);

      for (const line of lines) {
        const parsed = JSON.parse(line);
        expect(parsed.id).toBeDefined();
        expect(parsed.code).toBeDefined();
      }
    } finally {
      cleanupDir(tmpDir);
    }
  });

  test("merges status and durationMs when results provided", async () => {
    const tmpDir = await createFixture();

    try {
      const project = await scan({ root: tmpDir });
      const docs = await extract(project);
      const runResult = createFakeRunResult(docs.examples.map((e) => e.id));

      const result = await renderers.jsonl.render(docs, { results: runResult });

      const lines = result.files[0].contents.trim().split("\n");

      const passed = JSON.parse(lines[0]);
      expect(passed.status).toBe("passed");
      expect(passed.durationMs).toBe(5);

      const pending = JSON.parse(lines[1]);
      expect(pending.status).toBe("pending");
      expect(pending.durationMs).toBe(0);
    } finally {
      cleanupDir(tmpDir);
    }
  });

  test("omits status when results not provided", async () => {
    const tmpDir = await createFixture();

    try {
      const project = await scan({ root: tmpDir });
      const docs = await extract(project);

      const result = await renderers.jsonl.render(docs, {});

      const lines = result.files[0].contents.trim().split("\n");
      const example = JSON.parse(lines[0]);

      expect(example.status).toBeUndefined();
      expect(example.durationMs).toBeUndefined();
    } finally {
      cleanupDir(tmpDir);
    }
  });

  test("each line is independently valid JSON", async () => {
    const tmpDir = await createFixture();

    try {
      const project = await scan({ root: tmpDir });
      const docs = await extract(project);
      const runResult = createFakeRunResult(docs.examples.map((e) => e.id));

      const result = await renderers.jsonl.render(docs, { results: runResult });

      const lines = result.files[0].contents.trim().split("\n");

      for (const line of lines) {
        expect(() => JSON.parse(line)).not.toThrow();
      }
    } finally {
      cleanupDir(tmpDir);
    }
  });

  test("ends with newline", async () => {
    const tmpDir = await createFixture();

    try {
      const project = await scan({ root: tmpDir });
      const docs = await extract(project);

      const result = await renderers.jsonl.render(docs, {});
      const content = result.files[0].contents;

      if (content.length > 0) {
        expect(content).toMatch(/\n$/);
      }
    } finally {
      cleanupDir(tmpDir);
    }
  });
});

describe("renderer registry", () => {
  test("exports all four renderers", () => {
    expect(renderers.markdown).toBeDefined();
    expect(renderers.html).toBeDefined();
    expect(renderers.json).toBeDefined();
    expect(renderers.jsonl).toBeDefined();

    expect(renderers.markdown.name).toBe("markdown");
    expect(renderers.html.name).toBe("html");
    expect(renderers.json.name).toBe("json");
    expect(renderers.jsonl.name).toBe("jsonl");
  });
});
