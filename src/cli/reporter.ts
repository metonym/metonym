/**
 * Pretty reporter.
 * Failures point at the original documentation, with the generated test as a
 * debugging pointer. Diagnostics go to stderr; stdout stays pipe-friendly.
 */

import type { ExampleResult, RunResult } from "../ir/types";
import { c } from "./colors";

const MARK: Record<ExampleResult["status"], string> = {
  passed: "✓",
  failed: "✗",
  pending: "○",
  skipped: "-",
};

export async function reportPretty(
  result: RunResult,
  root: string,
): Promise<void> {
  const byFile = new Map<string, ExampleResult[]>();
  for (const r of result.results) {
    const list = byFile.get(r.docFile) ?? [];
    list.push(r);
    byFile.set(r.docFile, list);
  }

  const out: string[] = [];
  for (const [file, results] of byFile) {
    out.push(c.bold(file));
    for (const r of results) {
      const mark =
        r.status === "passed"
          ? c.green(MARK.passed)
          : r.status === "failed"
            ? c.red(MARK.failed)
            : c.yellow(MARK[r.status]);
      const where =
        r.status === "failed" && r.failure?.doc
          ? `  ${c.dim(`${r.failure.doc.file}:${r.failure.doc.line}`)}`
          : r.status === "pending"
            ? `  ${c.dim("pending")}`
            : r.status === "passed"
              ? `  ${c.dim(`(${Math.round(r.durationMs)}ms)`)}`
              : "";
      out.push(`  ${mark} ${r.title}${where}`);
    }
    out.push("");
  }

  for (const r of result.results) {
    if (r.status !== "failed" || !r.failure) continue;
    out.push(c.bold(c.red("Documentation example failed")));
    out.push("");
    const doc = r.failure.doc;
    if (doc) {
      out.push(`  ${c.bold(`${doc.file}:${doc.line}`)}`);
      out.push(`  ${r.title}`);
      out.push("");
      out.push(...(await excerpt(root, doc.file, doc.line, doc.column)));
      out.push("");
    } else {
      out.push(`  ${r.title} ${c.dim("(location could not be remapped)")}`);
      out.push("");
    }
    for (const line of r.failure.message.split("\n")) {
      if (line.trim()) out.push(`  ${line}`);
    }
    out.push("");
    out.push(
      `  ${c.dim("Generated test:")} ${result.outDir}/${r.failure.generated.file}` +
        (r.failure.generated.line ? c.dim(`:${r.failure.generated.line}`) : ""),
    );
    out.push("");
  }

  const t = result.totals;
  const parts = [
    `${t.total} example${t.total === 1 ? "" : "s"}`,
    t.passed ? c.green(`${t.passed} passed`) : `${t.passed} passed`,
  ];
  if (t.failed) parts.push(c.red(`${t.failed} failed`));
  if (t.pending) parts.push(c.yellow(`${t.pending} pending`));
  if (t.skipped) parts.push(`${t.skipped} skipped`);
  if (t.cached) parts.push(c.dim(`${t.cached} cached`));
  out.push(parts.join(" · "));

  process.stderr.write(`${out.join("\n")}\n`);
}

async function excerpt(
  root: string,
  file: string,
  line: number,
  column?: number,
): Promise<string[]> {
  try {
    const text = await Bun.file(`${root}/${file}`).text();
    const lines = text.split("\n");
    const from = Math.max(1, line - 2);
    const to = Math.min(lines.length, line + 1);
    const width = String(to).length;
    const rows: string[] = [];
    for (let n = from; n <= to; n++) {
      const marker = n === line ? ">" : " ";
      rows.push(
        `  ${marker} ${String(n).padStart(width)} | ${lines[n - 1] ?? ""}`,
      );
    }
    if (column && column > 0) {
      const caretPad = " ".repeat(4 + String(line).length + 3 + column - 1);
      const idx = rows.findIndex((r) => r.startsWith("  > "));
      if (idx >= 0) rows.splice(idx + 1, 0, `${caretPad}^`);
    }
    return rows;
  } catch {
    return [`  ${file}:${line}`];
  }
}
