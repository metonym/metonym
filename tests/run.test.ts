/**
 * Comprehensive tests for run.ts and junit.ts.
 * Tests JUnit parsing, failure remapping, and end-to-end execution.
 */

import { describe, expect, test } from "bun:test";
import { mkdir, rm } from "node:fs/promises";
import {
  type DocumentationSet,
  type GeneratedTest,
  run,
  type SidecarMap,
} from "metonym";
import {
  decodeEntities,
  parseExpectedReceived,
  parseJUnit,
  parseStackFrames,
} from "../src/run/junit";

describe("decodeEntities", () => {
  test("decodes newlines and tabs", () => {
    expect(decodeEntities("hello&#10;world&#9;tab")).toBe("hello\nworld\ttab");
  });

  test("decodes quotes", () => {
    expect(decodeEntities("&quot;hello&quot; &apos;world&apos;")).toBe(
      "\"hello\" 'world'",
    );
  });

  test("decodes HTML entities in correct order", () => {
    expect(decodeEntities("&amp;quot; &amp;lt;")).toBe("&quot; &lt;");
  });

  test("decodes all entity types", () => {
    expect(
      decodeEntities("&#10;&#13;&#9;&quot;&apos;&#039;&amp;&lt;&gt;"),
    ).toBe("\n\r\t\"''&<>");
  });
});

describe("parseStackFrames", () => {
  test("parses frames with function name and location", () => {
    const text =
      "at helperWithExpect (fixtures/deep-fail.test.ts:4:15)\n      at fixtures/deep-fail.test.ts:9:5";
    const frames = parseStackFrames(text);

    expect(frames.length).toBe(2);
    expect(frames[0]).toEqual({
      fn: "helperWithExpect",
      file: "fixtures/deep-fail.test.ts",
      line: 4,
      column: 15,
    });
    expect(frames[1]).toEqual({
      fn: undefined,
      file: "fixtures/deep-fail.test.ts",
      line: 9,
      column: 5,
    });
  });

  test("handles deeply nested function names", () => {
    const text = "at Object.someFn.nested (path/to/file.ts:10:20)";
    const frames = parseStackFrames(text);

    expect(frames.length).toBe(1);
    expect(frames[0].fn).toBe("Object.someFn.nested");
    expect(frames[0].line).toBe(10);
  });

  test("returns empty array when no frames found", () => {
    const frames = parseStackFrames("no frames here");
    expect(frames.length).toBe(0);
  });
});

describe("parseExpectedReceived", () => {
  test("parses expected and received from message", () => {
    const msg = `expect(received).toBe(expected)

Expected: "y"
Received: "x"`;
    const result = parseExpectedReceived(msg);

    expect(result.expected).toBe('"y"');
    expect(result.received).toBe('"x"');
  });

  test("handles numeric expected/received", () => {
    const msg = `Expected: 10
Received: 5`;
    const result = parseExpectedReceived(msg);

    expect(result.expected).toBe("10");
    expect(result.received).toBe("5");
  });

  test("returns undefined for missing values", () => {
    const result = parseExpectedReceived("Some other message");
    expect(result.expected).toBeUndefined();
    expect(result.received).toBeUndefined();
  });
});

describe("parseJUnit", () => {
  test("parses passing test case", () => {
    const xml = `<testcase name="should pass" classname="multi" time="0.000007" file="fixtures/multi.test.ts" line="4" assertions="1" />`;
    const cases = parseJUnit(xml);

    expect(cases.length).toBe(1);
    expect(cases[0]).toEqual({
      name: "should pass",
      classname: "multi",
      file: "fixtures/multi.test.ts",
      line: 4,
      timeSec: 0.000007,
      status: "passed",
      failure: undefined,
    });
  });

  test("parses failing test case with failure element", () => {
    const xml = `<testcase name="should fail" classname="multi" time="0.000039" file="fixtures/multi.test.ts" line="8" assertions="1">
        <failure type="AssertionError" message="expect(received).toBe(expected)&#10;&#10;Expected: 10&#10;Received: 5&#10;">AssertionError: expect(received).toBe(expected)&#10;&#10;Expected: 10&#10;Received: 5&#10;&#10;      at fixtures/multi.test.ts:9:15&#10;</failure>
      </testcase>`;
    const cases = parseJUnit(xml);

    expect(cases.length).toBe(1);
    expect(cases[0].status).toBe("failed");
    expect(cases[0].failure).toBeDefined();
    expect(cases[0].failure?.type).toBe("AssertionError");
    expect(cases[0].failure?.message).toContain("Expected: 10");
    expect(cases[0].failure?.body).toContain("at fixtures/multi.test.ts:9:15");
  });

  test("parses todo test case", () => {
    const xml = `<testcase name="planned api" classname="multi" time="0" file="fixtures/multi.test.ts" line="12" assertions="0">
        <skipped message="TODO" />
      </testcase>`;
    const cases = parseJUnit(xml);

    expect(cases.length).toBe(1);
    expect(cases[0].status).toBe("todo");
  });

  test("parses multiple test cases", () => {
    const xml = `<testsuites>
      <testcase name="test1" classname="suite1" time="0.001" />
      <testcase name="test2" classname="suite1" time="0.002">
        <failure type="Error" message="boom">Error stack here</failure>
      </testcase>
    </testsuites>`;
    const cases = parseJUnit(xml);

    expect(cases.length).toBe(2);
    expect(cases[0].status).toBe("passed");
    expect(cases[1].status).toBe("failed");
  });
});

describe("run() - end-to-end execution", () => {
  test("executes generated tests and reports results", async () => {
    const tmpRoot = `/tmp/metonym-test-${Date.now()}`;
    await mkdir(tmpRoot, { recursive: true });

    try {
      const testCode = `import { describe, test, expect } from "bun:test";
describe("README.md", () => {
  test("Demo › example 1 (README.md:10)", async () => {
    const x = 2 + 3;
    expect(x).toBe(5);
  });
  test("Demo › example 2 (README.md:20)", async () => {
    expect(1).toBe(1);
  });
  test.todo("Demo › example 3 (README.md:30)");
});`;

      const sidecar: SidecarMap = {
        version: 1,
        source: "README.md",
        testFile: "README.md.test.ts",
        entries: [
          {
            exampleId: "ex:README.md:abc123d1",
            title: "Demo › example 1",
            kind: "assertion",
            docFile: "README.md",
            docCodeStartLine: 10,
            genCodeStartLine: 5,
            genCodeEndLine: 8,
          },
          {
            exampleId: "ex:README.md:abc123d2",
            title: "Demo › example 2",
            kind: "assertion",
            docFile: "README.md",
            docCodeStartLine: 20,
            genCodeStartLine: 9,
            genCodeEndLine: 11,
          },
          {
            exampleId: "ex:README.md:abc123d3",
            title: "Demo › example 3",
            kind: "pending",
            docFile: "README.md",
            docCodeStartLine: 30,
            genCodeStartLine: 12,
            genCodeEndLine: 12,
          },
        ],
      };

      const generated: GeneratedTest[] = [
        {
          path: "README.md.test.ts",
          code: testCode,
          map: sidecar,
        },
      ];

      const docs: DocumentationSet = {
        irVersion: 1,
        tool: { name: "metonym", version: "0.1.0" },
        root: tmpRoot,
        documents: [],
        examples: [],
        symbols: [],
        relations: [],
      };

      const result = await run(docs, {
        generated,
        outDir: `${tmpRoot}/.metonym/tests`,
      });

      expect(result.results.length).toBe(3);
      expect(result.totals.passed).toBe(2);
      expect(result.totals.pending).toBe(1);
      expect(result.totals.failed).toBe(0);
      expect(result.totals.total).toBe(3);
      expect(result.exitCode).toBe(0);

      const example1 = result.results.find(
        (r) => r.exampleId === "ex:README.md:abc123d1",
      );
      expect(example1?.status).toBe("passed");
      expect(example1?.durationMs).toBeGreaterThan(0);

      const example3 = result.results.find(
        (r) => r.exampleId === "ex:README.md:abc123d3",
      );
      expect(example3?.status).toBe("pending");

      expect(result.results[0].exampleId).toBe("ex:README.md:abc123d1");
      expect(result.results[1].exampleId).toBe("ex:README.md:abc123d2");
      expect(result.results[2].exampleId).toBe("ex:README.md:abc123d3");
    } finally {
      await rm(tmpRoot, { recursive: true, force: true });
    }
  });

  test("remaps failure locations correctly", async () => {
    const tmpRoot = `/tmp/metonym-fail-${Date.now()}`;
    await mkdir(tmpRoot, { recursive: true });

    try {
      const testCode = `import { describe, test, expect } from "bun:test";
describe("README.md", () => {
  test("Demo › example 1 (README.md:10)", async () => {
    const x = 2 + 3;
    expect(x).toBe(6);
  });
});`;

      const sidecar: SidecarMap = {
        version: 1,
        source: "README.md",
        testFile: "README.md.test.ts",
        entries: [
          {
            exampleId: "ex:README.md:xyz789d1",
            title: "Demo › example 1",
            kind: "assertion",
            docFile: "README.md",
            docCodeStartLine: 10,
            genCodeStartLine: 4, // const x = ...
            genCodeEndLine: 5, // expect line
          },
        ],
      };

      const generated: GeneratedTest[] = [
        {
          path: "README.md.test.ts",
          code: testCode,
          map: sidecar,
        },
      ];

      const docs: DocumentationSet = {
        irVersion: 1,
        tool: { name: "metonym", version: "0.1.0" },
        root: tmpRoot,
        documents: [],
        examples: [],
        symbols: [],
        relations: [],
      };

      const result = await run(docs, {
        generated,
        outDir: `${tmpRoot}/.metonym/tests`,
      });

      expect(result.results.length).toBe(1);
      expect(result.results[0].status).toBe("failed");
      expect(result.results[0].failure).toBeDefined();

      // Verify remapping: expect line is at line 5 in generated file
      // So docLine = 10 + (5 - 4) = 11
      const failure = result.results[0].failure;
      expect(failure).toBeDefined();
      if (!failure) throw new Error("expected failure");
      expect(failure.doc?.file).toBe("README.md");
      expect(failure.doc?.line).toBe(11); // 10 + (5 - 4)
      expect(failure.expected).toBe("6");
      expect(failure.received).toBe("5");
      expect(result.exitCode).not.toBe(0);
    } finally {
      await rm(tmpRoot, { recursive: true, force: true });
    }
  });

  test("handles missing generated file gracefully", async () => {
    const tmpRoot = `/tmp/metonym-empty-${Date.now()}`;
    await mkdir(tmpRoot, { recursive: true });

    try {
      const docs: DocumentationSet = {
        irVersion: 1,
        tool: { name: "metonym", version: "0.1.0" },
        root: tmpRoot,
        documents: [],
        examples: [],
        symbols: [],
        relations: [],
      };

      const result = await run(docs, {
        generated: [],
        outDir: `${tmpRoot}/.metonym/tests`,
      });

      expect(result.results.length).toBe(0);
      expect(result.totals.total).toBe(0);
    } finally {
      await rm(tmpRoot, { recursive: true, force: true });
    }
  });

  test("handles group tests with shared failure", async () => {
    const tmpRoot = `/tmp/metonym-group-${Date.now()}`;
    await mkdir(tmpRoot, { recursive: true });

    try {
      const testCode = `import { describe, test, expect } from "bun:test";
describe("README.md", () => {
  test("Group › setup (README.md:10)", async () => {
    const x = 2 + 3;
    expect(x).toBe(6);
  });
});`;

      const sidecar: SidecarMap = {
        version: 1,
        source: "README.md",
        testFile: "README.md.test.ts",
        entries: [
          {
            exampleId: "ex:README.md:grp1",
            title: "Group › setup",
            kind: "assertion",
            docFile: "README.md",
            docCodeStartLine: 10,
            genCodeStartLine: 4,
            genCodeEndLine: 7,
          },
          {
            exampleId: "ex:README.md:grp2",
            title: "Group › setup",
            kind: "assertion",
            docFile: "README.md",
            docCodeStartLine: 15, // Same test, different entry
            genCodeStartLine: 4,
            genCodeEndLine: 7,
          },
        ],
      };

      const generated: GeneratedTest[] = [
        {
          path: "README.md.test.ts",
          code: testCode,
          map: sidecar,
        },
      ];

      const docs: DocumentationSet = {
        irVersion: 1,
        tool: { name: "metonym", version: "0.1.0" },
        root: tmpRoot,
        documents: [],
        examples: [],
        symbols: [],
        relations: [],
      };

      const result = await run(docs, {
        generated,
        outDir: `${tmpRoot}/.metonym/tests`,
      });

      expect(result.results.length).toBe(2);
      expect(result.results[0].status).toBe("failed");
      expect(result.results[1].status).toBe("failed");
    } finally {
      await rm(tmpRoot, { recursive: true, force: true });
    }
  });

  test("generates correct totals and exit code", async () => {
    const tmpRoot = `/tmp/metonym-totals-${Date.now()}`;
    await mkdir(tmpRoot, { recursive: true });

    try {
      const testCode = `import { describe, test, expect } from "bun:test";
describe("README.md", () => {
  test("Example 1 (README.md:10)", async () => {
    expect(1).toBe(1);
  });
  test("Example 2 (README.md:20)", async () => {
    expect(2).toBe(3);
  });
});`;

      const sidecar: SidecarMap = {
        version: 1,
        source: "README.md",
        testFile: "README.md.test.ts",
        entries: [
          {
            exampleId: "ex:pass",
            title: "Example 1",
            kind: "assertion",
            docFile: "README.md",
            docCodeStartLine: 10,
            genCodeStartLine: 4,
            genCodeEndLine: 6,
          },
          {
            exampleId: "ex:fail",
            title: "Example 2",
            kind: "assertion",
            docFile: "README.md",
            docCodeStartLine: 20,
            genCodeStartLine: 7,
            genCodeEndLine: 9,
          },
        ],
      };

      const generated: GeneratedTest[] = [
        {
          path: "README.md.test.ts",
          code: testCode,
          map: sidecar,
        },
      ];

      const docs: DocumentationSet = {
        irVersion: 1,
        tool: { name: "metonym", version: "0.1.0" },
        root: tmpRoot,
        documents: [],
        examples: [],
        symbols: [],
        relations: [],
      };

      const result = await run(docs, {
        generated,
        outDir: `${tmpRoot}/.metonym/tests`,
      });

      expect(result.totals.total).toBe(2);
      expect(result.totals.passed).toBe(1);
      expect(result.totals.failed).toBe(1);
      expect(result.totals.pending).toBe(0);
      expect(result.totals.skipped).toBe(0);
      expect(result.totals.durationMs).toBeGreaterThan(0);
      expect(result.exitCode).not.toBe(0);
    } finally {
      await rm(tmpRoot, { recursive: true, force: true });
    }
  });
});
