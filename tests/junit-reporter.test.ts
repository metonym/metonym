/**
 * Unit tests for the JUnit reporter: build a hand-crafted RunResult, render
 * it, then parse the output back with the existing bun-JUnit parser to
 * assert counts and the remapped file/line attributes round-trip.
 */

import { describe, expect, test } from "bun:test";
import { reportJunit } from "../src/cli/reporters/junit";
import type { RunResult } from "../src/ir/types";
import { parseJUnit } from "../src/run/junit";

function baseTotals(overrides: Partial<RunResult["totals"]> = {}) {
  return {
    total: 0,
    passed: 0,
    failed: 0,
    pending: 0,
    skipped: 0,
    durationMs: 0,
    ...overrides,
  };
}

describe("reportJunit", () => {
  test("round-trips counts and remapped file/line through parseJUnit", () => {
    const result: RunResult = {
      results: [
        {
          exampleId: "ex1",
          title: "Quick start › example 1",
          docFile: "README.md",
          docLine: 6,
          status: "passed",
          durationMs: 12,
        },
        {
          exampleId: "ex2",
          title: "Broken claim › example 1",
          docFile: "README.md",
          docLine: 13,
          status: "failed",
          durationMs: 5,
          failure: {
            message:
              "expect(received).toBe(expected)\nExpected: 6\nReceived: 5",
            doc: { file: "README.md", line: 15, column: 1 },
            generated: { file: "README.md.test.ts", line: 4 },
          },
        },
        {
          exampleId: "ex3",
          title: "Future API › example 1",
          docFile: "README.md",
          docLine: 20,
          status: "pending",
          durationMs: 0,
        },
        {
          exampleId: "ex4",
          title: "Never run › example 1",
          docFile: "README.md",
          docLine: 25,
          status: "skipped",
          durationMs: 0,
        },
      ],
      totals: baseTotals({
        total: 4,
        passed: 1,
        failed: 1,
        pending: 1,
        skipped: 1,
      }),
      outDir: ".metonym/tests",
      exitCode: 1,
    };

    const xml = reportJunit(result);
    const cases = parseJUnit(xml);

    expect(cases.length).toBe(4);
    expect(cases.filter((c) => c.status === "passed").length).toBe(1);
    expect(cases.filter((c) => c.status === "failed").length).toBe(1);
    // parseJUnit only maps a literal "TODO" skipped-message to "todo"; our
    // pending marker uses the lowercase "pending" message the task spec
    // calls for, so it round-trips as a plain "skipped" case.
    expect(cases.filter((c) => c.status === "skipped").length).toBe(2);

    const failed = cases.find((c) => c.name === "Broken claim › example 1");
    expect(failed?.file).toBe("README.md");
    expect(failed?.line).toBe(15); // remapped assertion line, not docLine
    expect(failed?.failure?.message).toContain("Expected: 6");

    const passed = cases.find((c) => c.name === "Quick start › example 1");
    expect(passed?.file).toBe("README.md");
    expect(passed?.line).toBe(6); // falls back to docLine

    const pending = cases.find((c) => c.name === "Future API › example 1");
    expect(pending?.status).toBe("skipped"); // parseJUnit only maps "TODO" body to todo
  });

  test("escapes XML special characters in titles and messages", () => {
    const result: RunResult = {
      results: [
        {
          exampleId: "ex1",
          title: `Title with <tag> & "quotes"`,
          docFile: "README.md",
          docLine: 1,
          status: "failed",
          durationMs: 1,
          failure: {
            message: `expected <a> & "b"`,
            doc: { file: "README.md", line: 1 },
            generated: { file: "README.md.test.ts", line: 1 },
          },
        },
      ],
      totals: baseTotals({ total: 1, failed: 1 }),
      outDir: ".metonym/tests",
      exitCode: 1,
    };

    const xml = reportJunit(result);
    expect(xml).not.toContain('name="Title with <tag>');
    const cases = parseJUnit(xml);
    // parseJUnit only entity-decodes the failure type/message/body, not
    // name/classname, so the raw XML-escaped form round-trips for name.
    expect(cases[0].name).toBe(
      `Title with &lt;tag&gt; &amp; &quot;quotes&quot;`,
    );
    expect(cases[0].failure?.message).toBe(`expected <a> & "b"`);
  });

  test("groups testcases into one testsuite per doc file", () => {
    const result: RunResult = {
      results: [
        {
          exampleId: "ex1",
          title: "a",
          docFile: "README.md",
          docLine: 1,
          status: "passed",
          durationMs: 1,
        },
        {
          exampleId: "ex2",
          title: "b",
          docFile: "docs/guide.md",
          docLine: 1,
          status: "passed",
          durationMs: 1,
        },
      ],
      totals: baseTotals({ total: 2, passed: 2 }),
      outDir: ".metonym/tests",
      exitCode: 0,
    };

    const xml = reportJunit(result);
    expect(xml.match(/<testsuite /g)?.length).toBe(2);
    expect(xml).toContain('<testsuite name="README.md"');
    expect(xml).toContain('<testsuite name="docs/guide.md"');
  });
});
