/**
 * Unit tests for the GitHub Actions reporter, against hand-built RunResults
 * (no CLI spawn — e2e.test.ts covers auto-select end to end).
 */

import { describe, expect, test } from "bun:test";
import { reportGithub } from "../src/cli/reporters/github";
import type { RunResult } from "../src/ir/types";

function capture(fn: () => void): string {
  const chunks: string[] = [];
  const original = process.stdout.write;
  process.stdout.write = ((chunk: string) => {
    chunks.push(chunk);
    return true;
  }) as typeof process.stdout.write;
  try {
    fn();
  } finally {
    process.stdout.write = original;
  }
  return chunks.join("");
}

function baseTotals(overrides: Partial<RunResult["totals"]> = {}) {
  return {
    total: 1,
    passed: 0,
    failed: 0,
    pending: 0,
    skipped: 0,
    durationMs: 0,
    ...overrides,
  };
}

describe("reportGithub", () => {
  test("a failed example with a remapped doc location produces an ::error annotation", () => {
    const result: RunResult = {
      results: [
        {
          exampleId: "ex1",
          title: "Quick start › example 1",
          docFile: "README.md",
          docLine: 18,
          status: "failed",
          durationMs: 1,
          failure: {
            message: "expect(received).toBe(expected)\nExpected: 5\nReceived: 6",
            doc: { file: "README.md", line: 18, column: 27 },
            generated: { file: "README.md.test.ts", line: 4, column: 5 },
          },
        },
      ],
      totals: baseTotals({ failed: 1 }),
      outDir: ".metonym/tests",
      exitCode: 1,
    };

    const out = capture(() => reportGithub(result));
    expect(out).toContain(
      "::error file=README.md,line=18,col=27,title=Documentation example failed::",
    );
    expect(out).toContain("expect(received).toBe(expected)");
  });

  test("escapes %, \\r, \\n in the annotation message", () => {
    const result: RunResult = {
      results: [
        {
          exampleId: "ex1",
          title: "Example",
          docFile: "README.md",
          docLine: 1,
          status: "failed",
          durationMs: 1,
          failure: {
            message: "100% done\r\nnext line",
            doc: { file: "README.md", line: 1, column: 1 },
            generated: { file: "README.md.test.ts", line: 1 },
          },
        },
      ],
      totals: baseTotals({ failed: 1 }),
      outDir: ".metonym/tests",
      exitCode: 1,
    };

    const out = capture(() => reportGithub(result));
    expect(out).toContain("100%25 done");
    expect(out).not.toContain("100% done");
    expect(out).not.toContain("\r\n");
  });

  test("an unmapped failure falls back to the generated location and title", () => {
    const result: RunResult = {
      results: [
        {
          exampleId: "ex1",
          title: "Example",
          docFile: "README.md",
          status: "failed",
          durationMs: 1,
          failure: {
            message: "boom",
            generated: { file: ".metonym/tests/README.md.test.ts", line: 4 },
          },
        },
      ],
      totals: baseTotals({ failed: 1 }),
      outDir: ".metonym/tests",
      exitCode: 1,
    };

    const out = capture(() => reportGithub(result));
    expect(out).toContain(
      "title=Documentation example failed (unmapped)::",
    );
    expect(out).toContain("file=.metonym/tests/README.md.test.ts,line=4,");
  });

  test("a pending example produces a ::notice annotation", () => {
    const result: RunResult = {
      results: [
        {
          exampleId: "ex1",
          title: "Future API › example 1",
          docFile: "README.md",
          docLine: 30,
          status: "pending",
          durationMs: 0,
        },
      ],
      totals: baseTotals({ pending: 1 }),
      outDir: ".metonym/tests",
      exitCode: 0,
    };

    const out = capture(() => reportGithub(result));
    expect(out).toContain(
      "::notice file=README.md,line=30,title=Pending example::Future API › example 1",
    );
  });

  test("junitMissing emits an error plus the first 20 lines of stderr", () => {
    const stderrLines = Array.from({ length: 25 }, (_, i) => `line ${i}`);
    const result: RunResult = {
      results: [],
      totals: baseTotals({ total: 0 }),
      outDir: ".metonym/tests",
      exitCode: 1,
      junitMissing: true,
      stderr: stderrLines.join("\n"),
    };

    const out = capture(() => reportGithub(result));
    expect(out).toContain(
      "::error title=metonym::test run did not complete cleanly",
    );
    expect(out).toContain("::error::line 0");
    expect(out).toContain("::error::line 19");
    expect(out).not.toContain("::error::line 20");
  });

  test("finishes with a summary notice", () => {
    const result: RunResult = {
      results: [],
      totals: baseTotals({ total: 3, passed: 2, failed: 1, pending: 0 }),
      outDir: ".metonym/tests",
      exitCode: 1,
    };

    const out = capture(() => reportGithub(result));
    expect(out).toContain(
      "::notice title=metonym::3 examples · 2 passed · 1 failed · 0 pending",
    );
  });
});
