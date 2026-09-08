/**
 * JUnit XML reporter, built from `RunResult` (not the child `bun test`
 * process's raw JUnit file, which is keyed by generated location rather
 * than the doc-remapped one CI actually wants).
 */

import type { ExampleResult, RunResult } from "../../ir/types";

function escapeAttr(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;")
    .replace(/\r/g, "&#13;")
    .replace(/\n/g, "&#10;")
    .replace(/\t/g, "&#9;");
}

function escapeText(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function testcaseXml(r: ExampleResult): string {
  const doc = r.failure?.doc;
  const line = doc?.line ?? r.docLine;
  const attrs = [
    `name="${escapeAttr(r.title)}"`,
    `classname="${escapeAttr(r.docFile)}"`,
    `file="${escapeAttr(doc?.file ?? r.docFile)}"`,
    line !== undefined ? `line="${line}"` : undefined,
    `time="${(r.durationMs / 1000).toFixed(3)}"`,
  ]
    .filter((a): a is string => a !== undefined)
    .join(" ");

  if (r.status === "failed" && r.failure) {
    const generatedLoc = r.failure.generated.line
      ? `${r.failure.generated.file}:${r.failure.generated.line}`
      : r.failure.generated.file;
    const body = `${r.failure.message}\n\nGenerated: ${generatedLoc}`;
    return (
      `    <testcase ${attrs}>\n` +
      `      <failure type="AssertionError" message="${escapeAttr(r.failure.message)}">${escapeText(body)}</failure>\n` +
      `    </testcase>`
    );
  }
  if (r.status === "pending") {
    return `    <testcase ${attrs}>\n      <skipped message="pending" />\n    </testcase>`;
  }
  if (r.status === "skipped") {
    return `    <testcase ${attrs}>\n      <skipped />\n    </testcase>`;
  }
  return `    <testcase ${attrs}/>`;
}

export function reportJunit(result: RunResult): string {
  const byFile = new Map<string, ExampleResult[]>();
  for (const r of result.results) {
    const list = byFile.get(r.docFile) ?? [];
    list.push(r);
    byFile.set(r.docFile, list);
  }

  const suites: string[] = [];
  for (const [file, results] of byFile) {
    const failures = results.filter((r) => r.status === "failed").length;
    const skipped = results.filter(
      (r) => r.status === "pending" || r.status === "skipped",
    ).length;
    const cases = results.map(testcaseXml).join("\n");
    suites.push(
      `  <testsuite name="${escapeAttr(file)}" tests="${results.length}" failures="${failures}" skipped="${skipped}">\n${cases}\n  </testsuite>`,
    );
  }

  return `<?xml version="1.0" encoding="UTF-8"?>\n<testsuites>\n${suites.join("\n")}\n</testsuites>\n`;
}
