/**
 * Tests for the pretty reporter's timeout and slow-example formatting.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { reportPretty } from "../src/cli/reporter";
import type { RunResult } from "../src/ir/types";

async function captureStderr(fn: () => Promise<void>): Promise<string> {
  const original = process.stderr.write.bind(process.stderr);
  let out = "";
  process.stderr.write = ((chunk: string) => {
    out += chunk;
    return true;
  }) as typeof process.stderr.write;
  try {
    await fn();
  } finally {
    process.stderr.write = original;
  }
  return out;
}

function baseResult(overrides: Partial<RunResult> = {}): RunResult {
  return {
    results: [],
    totals: {
      total: 0,
      passed: 0,
      failed: 0,
      pending: 0,
      skipped: 0,
      durationMs: 0,
    },
    outDir: "/tmp/does-not-matter",
    exitCode: 0,
    ...overrides,
  };
}

describe("reportPretty", () => {
  test("a timed-out failure shows 'timed out after <ms>ms' instead of the doc location", async () => {
    const result = baseResult({
      results: [
        {
          exampleId: "ex:1",
          title: "Slow › example 1",
          docFile: "README.md",
          status: "failed",
          durationMs: 5000,
          failure: {
            message: "test timed out",
            type: "TimeoutError",
            generated: { file: "README.md.test.ts" },
          },
        },
      ],
      totals: {
        total: 1,
        passed: 0,
        failed: 1,
        pending: 0,
        skipped: 0,
        durationMs: 5000,
      },
    });

    const out = await captureStderr(() => reportPretty(result, "/tmp"));
    expect(out).toContain("timed out after 5000ms");
    expect(out).not.toContain("README.md:");
  });

  test("the doc location is still shown in the detail block when available", async () => {
    const result = baseResult({
      results: [
        {
          exampleId: "ex:1",
          title: "Slow › example 1",
          docFile: "README.md",
          status: "failed",
          durationMs: 5000,
          failure: {
            message: "test timed out",
            type: "TimeoutError",
            doc: { file: "README.md", line: 10 },
            generated: { file: "README.md.test.ts" },
          },
        },
      ],
      totals: {
        total: 1,
        passed: 0,
        failed: 1,
        pending: 0,
        skipped: 0,
        durationMs: 5000,
      },
    });

    const out = await captureStderr(() => reportPretty(result, "/tmp"));
    expect(out).toContain("timed out after 5000ms");
    expect(out).toContain("README.md:10");
  });

  test("a passed example slower than 1000ms is flagged", async () => {
    const result = baseResult({
      results: [
        {
          exampleId: "ex:1",
          title: "Slow pass › example 1",
          docFile: "README.md",
          status: "passed",
          durationMs: 1500,
        },
      ],
      totals: {
        total: 1,
        passed: 1,
        failed: 0,
        pending: 0,
        skipped: 0,
        durationMs: 1500,
      },
    });

    const out = await captureStderr(() => reportPretty(result, "/tmp"));
    expect(out).toContain("(1500ms)");
  });

  describe("`// =>` failures", () => {
    let root: string;

    beforeAll(async () => {
      root = await mkdtemp(join(tmpdir(), "metonym-reporter-"));
      await Bun.write(
        join(root, "README.md"),
        ["```ts", "add(1, 2) // => 4", "```", ""].join("\n"),
      );
    });

    afterAll(async () => {
      await rm(root, { recursive: true, force: true });
    });

    test("shows expected (doc) and received above the message", async () => {
      const result = baseResult({
        results: [
          {
            exampleId: "ex:1",
            title: "README.md › example 1",
            docFile: "README.md",
            status: "failed",
            durationMs: 5,
            failure: {
              message: "expect(received).toEqual(expected)",
              expected: "4",
              received: "3",
              doc: { file: "README.md", line: 2 },
              generated: { file: "README.md.test.ts" },
            },
          },
        ],
        totals: {
          total: 1,
          passed: 0,
          failed: 1,
          pending: 0,
          skipped: 0,
          durationMs: 5,
        },
      });

      const out = await captureStderr(() => reportPretty(result, root));
      expect(out).toContain("expected (doc): 4");
      expect(out).toContain("received: 3");
    });
  });
});
