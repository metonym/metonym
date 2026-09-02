import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkCoverage, coverage, type DocumentationSet } from "metonym";
import { loadConfig } from "../src/config";

test("coverage(): excludes symbols with declKind 'reexport' from denominator", () => {
  const docs: DocumentationSet = {
    irVersion: 1,
    tool: { name: "metonym", version: "0.1.0" },
    root: "/tmp/test",
    documents: [],
    examples: [],
    symbols: [
      // Regular function: counted
      {
        id: "sym:src/index.ts:add",
        file: "src/index.ts",
        name: "add",
        imports: [],
        declKind: "function",
      },
      // Reexport: excluded from denominator
      {
        id: "sym:src/index.ts:helper",
        file: "src/index.ts",
        name: "helper",
        imports: [],
        declKind: "reexport",
      },
    ],
    relations: [],
  };

  const report = coverage(docs);
  expect(report.symbols.total).toBe(1); // Only the regular function
  expect(report.reexports).toBe(1);
});

test("coverage(): excludes symbols with name '*' from denominator", () => {
  const docs: DocumentationSet = {
    irVersion: 1,
    tool: { name: "metonym", version: "0.1.0" },
    root: "/tmp/test",
    documents: [],
    examples: [],
    symbols: [
      {
        id: "sym:src/index.ts:add",
        file: "src/index.ts",
        name: "add",
        imports: [],
        declKind: "function",
      },
      // Barrel export: excluded from denominator
      {
        id: "sym:src/index.ts:*",
        file: "src/index.ts",
        name: "*",
        imports: [],
      },
    ],
    relations: [],
  };

  const report = coverage(docs);
  expect(report.symbols.total).toBe(1);
  expect(report.reexports).toBe(1);
});

test("coverage(): reexports not in undocumented list", () => {
  const docs: DocumentationSet = {
    irVersion: 1,
    tool: { name: "metonym", version: "0.1.0" },
    root: "/tmp/test",
    documents: [],
    examples: [],
    symbols: [
      {
        id: "sym:src/index.ts:add",
        file: "src/index.ts",
        name: "add",
        imports: [],
        declKind: "function",
      },
      {
        id: "sym:src/index.ts:reex",
        file: "src/index.ts",
        name: "reex",
        imports: [],
        declKind: "reexport",
      },
    ],
    relations: [],
  };

  const report = coverage(docs);
  expect(report.undocumented.length).toBe(1);
  expect(report.undocumented[0].name).toBe("add");
});

test("coverage(): symbols without declKind are counted normally", () => {
  const docs: DocumentationSet = {
    irVersion: 1,
    tool: { name: "metonym", version: "0.1.0" },
    root: "/tmp/test",
    documents: [],
    examples: [],
    symbols: [
      {
        id: "sym:src/util.ts:helper",
        file: "src/util.ts",
        name: "helper",
        imports: [],
        // no declKind
      },
      {
        id: "sym:src/index.ts:add",
        file: "src/index.ts",
        name: "add",
        imports: [],
        declKind: "function",
      },
    ],
    relations: [],
  };

  const report = coverage(docs);
  expect(report.symbols.total).toBe(2);
  expect(report.undocumented.length).toBe(2);
  expect(report.reexports).toBe(0);
});

test("checkCoverage(): pass when all gates satisfied", () => {
  const docs: DocumentationSet = {
    irVersion: 1,
    tool: { name: "metonym", version: "0.1.0" },
    root: "/tmp/test",
    documents: [],
    examples: [],
    symbols: [
      {
        id: "sym:src/index.ts:add",
        file: "src/index.ts",
        name: "add",
        imports: [],
        declKind: "function",
      },
      {
        id: "sym:src/index.ts:multiply",
        file: "src/index.ts",
        name: "multiply",
        imports: [],
        declKind: "function",
      },
    ],
    relations: [
      { kind: "documents", from: "doc:README.md", to: "sym:src/index.ts:add" },
      { kind: "owns", from: "sym:src/index.ts:add", to: "example:1" },
    ],
  };

  const result = checkCoverage(docs, {
    minDocumented: 40, // 50% >= 40%
    minExamples: 40, // 50% >= 40%
    failOnUndocumented: false,
  });

  expect(result.pass).toBe(true);
  expect(result.failures.length).toBe(0);
});

test("checkCoverage(): fail minDocumented gate", () => {
  const docs: DocumentationSet = {
    irVersion: 1,
    tool: { name: "metonym", version: "0.1.0" },
    root: "/tmp/test",
    documents: [],
    examples: [],
    symbols: [
      {
        id: "sym:src/index.ts:add",
        file: "src/index.ts",
        name: "add",
        imports: [],
        declKind: "function",
      },
      {
        id: "sym:src/index.ts:multiply",
        file: "src/index.ts",
        name: "multiply",
        imports: [],
        declKind: "function",
      },
      {
        id: "sym:src/index.ts:divide",
        file: "src/index.ts",
        name: "divide",
        imports: [],
        declKind: "function",
      },
      {
        id: "sym:src/index.ts:subtract",
        file: "src/index.ts",
        name: "subtract",
        imports: [],
        declKind: "function",
      },
      {
        id: "sym:src/index.ts:power",
        file: "src/index.ts",
        name: "power",
        imports: [],
        declKind: "function",
      },
    ],
    relations: [
      { kind: "documents", from: "doc:README.md", to: "sym:src/index.ts:add" },
    ],
  };

  const result = checkCoverage(docs, {
    minDocumented: 80, // only 20% (1/5)
  });

  expect(result.pass).toBe(false);
  expect(result.failures.length).toBeGreaterThanOrEqual(1);
  expect(result.failures[0]).toContain("documented");
  expect(result.failures[0]).toContain("20");
  expect(result.failures[0]).toContain("80");
});

test("checkCoverage(): fail minExamples gate", () => {
  const docs: DocumentationSet = {
    irVersion: 1,
    tool: { name: "metonym", version: "0.1.0" },
    root: "/tmp/test",
    documents: [],
    examples: [],
    symbols: [
      {
        id: "sym:src/index.ts:add",
        file: "src/index.ts",
        name: "add",
        imports: [],
        declKind: "function",
      },
      {
        id: "sym:src/index.ts:multiply",
        file: "src/index.ts",
        name: "multiply",
        imports: [],
        declKind: "function",
      },
      {
        id: "sym:src/index.ts:divide",
        file: "src/index.ts",
        name: "divide",
        imports: [],
        declKind: "function",
      },
      {
        id: "sym:src/index.ts:subtract",
        file: "src/index.ts",
        name: "subtract",
        imports: [],
        declKind: "function",
      },
      {
        id: "sym:src/index.ts:power",
        file: "src/index.ts",
        name: "power",
        imports: [],
        declKind: "function",
      },
    ],
    relations: [
      { kind: "documents", from: "doc:README.md", to: "sym:src/index.ts:add" },
      { kind: "owns", from: "sym:src/index.ts:add", to: "example:1" },
    ],
  };

  const result = checkCoverage(docs, {
    minExamples: 80, // only 20% (1/5)
  });

  expect(result.pass).toBe(false);
  expect(result.failures.length).toBeGreaterThanOrEqual(1);
  expect(result.failures[0]).toContain("examples");
  expect(result.failures[0]).toContain("20");
  expect(result.failures[0]).toContain("80");
});

test("checkCoverage(): fail failOnUndocumented gate", () => {
  const docs: DocumentationSet = {
    irVersion: 1,
    tool: { name: "metonym", version: "0.1.0" },
    root: "/tmp/test",
    documents: [],
    examples: [],
    symbols: [
      {
        id: "sym:src/index.ts:add",
        file: "src/index.ts",
        name: "add",
        imports: [],
        declKind: "function",
      },
      {
        id: "sym:src/index.ts:multiply",
        file: "src/index.ts",
        name: "multiply",
        imports: [],
        declKind: "function",
      },
    ],
    relations: [
      { kind: "documents", from: "doc:README.md", to: "sym:src/index.ts:add" },
    ],
  };

  const result = checkCoverage(docs, {
    failOnUndocumented: true,
  });

  expect(result.pass).toBe(false);
  expect(result.failures.length).toBeGreaterThanOrEqual(1);
  expect(result.failures[0]).toContain("undocumented exports");
  expect(result.failures[0]).toContain("src/index.ts › multiply");
});

test("checkCoverage(): failOnUndocumented lists up to 10 symbols", () => {
  const docs: DocumentationSet = {
    irVersion: 1,
    tool: { name: "metonym", version: "0.1.0" },
    root: "/tmp/test",
    documents: [],
    examples: [],
    symbols: Array.from({ length: 15 }, (_, i) => ({
      id: `sym:src/index.ts:fn${i}`,
      file: "src/index.ts",
      name: `fn${i}`,
      imports: [],
      declKind: "function" as const,
    })),
    relations: [
      { kind: "documents", from: "doc:README.md", to: "sym:src/index.ts:fn0" },
    ],
  };

  const result = checkCoverage(docs, {
    failOnUndocumented: true,
  });

  expect(result.pass).toBe(false);
  expect(result.failures[0]).toContain("undocumented exports");
  expect(result.failures[0]).toContain("…and 4 more");
});

function makeExample(
  overrides: Partial<DocumentationSet["examples"][number]>,
): DocumentationSet["examples"][number] {
  const loc = {
    file: "README.md",
    start: { line: 1, column: 1, offset: 0 },
    end: { line: 1, column: 1, offset: 0 },
  };
  return {
    id: "ex:README.md:1",
    documentId: "doc:README.md",
    source: loc,
    fenceSource: loc,
    language: "ts",
    code: "expect(1).toBe(1);",
    kind: "assertion",
    title: "example 1",
    ...overrides,
  };
}

test("coverage(): counts examples and examplesWithTypeErrors", () => {
  const docs: DocumentationSet = {
    irVersion: 1,
    tool: { name: "metonym", version: "0.1.0" },
    root: "/tmp/test",
    documents: [],
    examples: [
      makeExample({ id: "ex:1", title: "clean" }),
      makeExample({
        id: "ex:2",
        title: "broken",
        diagnostics: [
          {
            severity: "error",
            message: "type mismatch",
            start: 0,
            length: 3,
            line: 1,
            column: 1,
            code: 2345,
          },
        ],
      }),
      // pending/ignored examples are excluded from the denominator
      makeExample({ id: "ex:3", title: "pending", kind: "pending" }),
    ],
    symbols: [],
    relations: [],
  };

  const report = coverage(docs);
  expect(report.examples.total).toBe(2);
  expect(report.examples.withTypeErrors).toBe(1);
  expect(report.examplesWithTypeErrors).toHaveLength(1);
  expect(report.examplesWithTypeErrors[0].id).toBe("ex:2");
  expect(report.examplesWithTypeErrors[0].errorCount).toBe(1);
});

test("checkCoverage(): fail failOnTypeErrors gate", () => {
  const docs: DocumentationSet = {
    irVersion: 1,
    tool: { name: "metonym", version: "0.1.0" },
    root: "/tmp/test",
    documents: [],
    examples: [
      makeExample({
        id: "ex:1",
        title: "broken",
        diagnostics: [
          {
            severity: "error",
            message: "type mismatch",
            start: 0,
            length: 3,
            line: 1,
            column: 1,
            code: 2345,
          },
        ],
      }),
    ],
    symbols: [],
    relations: [],
  };

  const result = checkCoverage(docs, { failOnTypeErrors: true });

  expect(result.pass).toBe(false);
  expect(result.failures.length).toBeGreaterThanOrEqual(1);
  expect(result.failures[0]).toContain("type errors");
  expect(result.failures[0]).toContain("broken");
});

test("checkCoverage(): failOnTypeErrors passes when no example has an error diagnostic", () => {
  const docs: DocumentationSet = {
    irVersion: 1,
    tool: { name: "metonym", version: "0.1.0" },
    root: "/tmp/test",
    documents: [],
    examples: [makeExample({ id: "ex:1" })],
    symbols: [],
    relations: [],
  };

  const result = checkCoverage(docs, { failOnTypeErrors: true });

  expect(result.pass).toBe(true);
  expect(result.failures).toHaveLength(0);
});

test("checkCoverage(): total 0 symbols → both percentage gates pass", () => {
  const docs: DocumentationSet = {
    irVersion: 1,
    tool: { name: "metonym", version: "0.1.0" },
    root: "/tmp/test",
    documents: [],
    examples: [],
    symbols: [
      {
        id: "sym:src/index.ts:reex",
        file: "src/index.ts",
        name: "reex",
        imports: [],
        declKind: "reexport",
      },
    ],
    relations: [],
  };

  const result = checkCoverage(docs, {
    minDocumented: 80,
    minExamples: 80,
  });

  expect(result.pass).toBe(true);
  expect(result.failures.length).toBe(0);
});

test("checkCoverage(): multiple failures listed", () => {
  const docs: DocumentationSet = {
    irVersion: 1,
    tool: { name: "metonym", version: "0.1.0" },
    root: "/tmp/test",
    documents: [],
    examples: [],
    symbols: [
      {
        id: "sym:src/index.ts:add",
        file: "src/index.ts",
        name: "add",
        imports: [],
        declKind: "function",
      },
      {
        id: "sym:src/index.ts:multiply",
        file: "src/index.ts",
        name: "multiply",
        imports: [],
        declKind: "function",
      },
    ],
    relations: [],
  };

  const result = checkCoverage(docs, {
    minDocumented: 80,
    minExamples: 80,
    failOnUndocumented: true,
  });

  expect(result.pass).toBe(false);
  expect(result.failures.length).toBeGreaterThanOrEqual(3);
});

test("loadConfig(): coverage key survives round-trip", async () => {
  let tmpDir: string | undefined;
  try {
    tmpDir = await mkdtemp(join(tmpdir(), "config-test-"));

    const packageJsonPath = join(tmpDir, "package.json");
    await Bun.write(
      packageJsonPath,
      JSON.stringify({
        name: "test-pkg",
        metonym: {
          coverage: {
            minDocumented: 80,
            minExamples: 60,
            failOnUndocumented: true,
          },
        },
      }),
    );

    const config = await loadConfig(tmpDir);

    expect(config.coverage).toBeDefined();
    expect(config.coverage?.minDocumented).toBe(80);
    expect(config.coverage?.minExamples).toBe(60);
    expect(config.coverage?.failOnUndocumented).toBe(true);
  } finally {
    if (tmpDir) {
      await rm(tmpDir, { recursive: true, force: true });
    }
  }
});

test("loadConfig(): rejects invalid minDocumented (non-number)", async () => {
  let tmpDir: string | undefined;
  try {
    tmpDir = await mkdtemp(join(tmpdir(), "config-test-"));

    const packageJsonPath = join(tmpDir, "package.json");
    await Bun.write(
      packageJsonPath,
      JSON.stringify({
        name: "test-pkg",
        metonym: {
          coverage: {
            minDocumented: "high",
          },
        },
      }),
    );

    let thrown = false;
    try {
      await loadConfig(tmpDir);
    } catch (e) {
      thrown = true;
      expect(String(e)).toContain("minDocumented");
    }
    expect(thrown).toBe(true);
  } finally {
    if (tmpDir) {
      await rm(tmpDir, { recursive: true, force: true });
    }
  }
});

test("loadConfig(): rejects minDocumented out of range", async () => {
  let tmpDir: string | undefined;
  try {
    tmpDir = await mkdtemp(join(tmpdir(), "config-test-"));

    const packageJsonPath = join(tmpDir, "package.json");
    await Bun.write(
      packageJsonPath,
      JSON.stringify({
        name: "test-pkg",
        metonym: {
          coverage: {
            minDocumented: 150,
          },
        },
      }),
    );

    let thrown = false;
    try {
      await loadConfig(tmpDir);
    } catch (e) {
      thrown = true;
      expect(String(e)).toContain("minDocumented");
      expect(String(e)).toContain("0 and 100");
    }
    expect(thrown).toBe(true);
  } finally {
    if (tmpDir) {
      await rm(tmpDir, { recursive: true, force: true });
    }
  }
});

test("loadConfig(): rejects invalid minExamples (non-number)", async () => {
  let tmpDir: string | undefined;
  try {
    tmpDir = await mkdtemp(join(tmpdir(), "config-test-"));

    const packageJsonPath = join(tmpDir, "package.json");
    await Bun.write(
      packageJsonPath,
      JSON.stringify({
        name: "test-pkg",
        metonym: {
          coverage: {
            minExamples: "lots",
          },
        },
      }),
    );

    let thrown = false;
    try {
      await loadConfig(tmpDir);
    } catch (e) {
      thrown = true;
      expect(String(e)).toContain("minExamples");
    }
    expect(thrown).toBe(true);
  } finally {
    if (tmpDir) {
      await rm(tmpDir, { recursive: true, force: true });
    }
  }
});

test("loadConfig(): rejects invalid failOnUndocumented (non-boolean)", async () => {
  let tmpDir: string | undefined;
  try {
    tmpDir = await mkdtemp(join(tmpdir(), "config-test-"));

    const packageJsonPath = join(tmpDir, "package.json");
    await Bun.write(
      packageJsonPath,
      JSON.stringify({
        name: "test-pkg",
        metonym: {
          coverage: {
            failOnUndocumented: "yes",
          },
        },
      }),
    );

    let thrown = false;
    try {
      await loadConfig(tmpDir);
    } catch (e) {
      thrown = true;
      expect(String(e)).toContain("failOnUndocumented");
    }
    expect(thrown).toBe(true);
  } finally {
    if (tmpDir) {
      await rm(tmpDir, { recursive: true, force: true });
    }
  }
});

test("loadConfig(): rejects invalid failOnTypeErrors (non-boolean)", async () => {
  let tmpDir: string | undefined;
  try {
    tmpDir = await mkdtemp(join(tmpdir(), "config-test-"));

    const packageJsonPath = join(tmpDir, "package.json");
    await Bun.write(
      packageJsonPath,
      JSON.stringify({
        name: "test-pkg",
        metonym: {
          coverage: {
            failOnTypeErrors: "yes",
          },
        },
      }),
    );

    let thrown = false;
    try {
      await loadConfig(tmpDir);
    } catch (e) {
      thrown = true;
      expect(String(e)).toContain("failOnTypeErrors");
    }
    expect(thrown).toBe(true);
  } finally {
    if (tmpDir) {
      await rm(tmpDir, { recursive: true, force: true });
    }
  }
});

test("loadConfig(): rejects coverage as non-object", async () => {
  let tmpDir: string | undefined;
  try {
    tmpDir = await mkdtemp(join(tmpdir(), "config-test-"));

    const packageJsonPath = join(tmpDir, "package.json");
    await Bun.write(
      packageJsonPath,
      JSON.stringify({
        name: "test-pkg",
        metonym: {
          coverage: "enable",
        },
      }),
    );

    let thrown = false;
    try {
      await loadConfig(tmpDir);
    } catch (e) {
      thrown = true;
      expect(String(e)).toContain("coverage");
      expect(String(e)).toContain("object");
    }
    expect(thrown).toBe(true);
  } finally {
    if (tmpDir) {
      await rm(tmpDir, { recursive: true, force: true });
    }
  }
});
