/**
 * GitHub Actions reporter: workflow commands to stdout so failures/pending
 * examples surface as inline PR annotations.
 */

import type { RunResult } from "../../ir/types";

/** Escapes `%`, `\r`, `\n` per the workflow-command data-escaping rules. */
function escapeData(s: string): string {
  return s.replace(/%/g, "%25").replace(/\r/g, "%0D").replace(/\n/g, "%0A");
}

/** Data escaping plus `:`/`,`, required for workflow-command property values. */
function escapeProperty(s: string): string {
  return escapeData(s).replace(/:/g, "%3A").replace(/,/g, "%2C");
}

function firstLine(message: string): string {
  const idx = message.indexOf("\n");
  return idx === -1 ? message : message.slice(0, idx);
}

export function reportGithub(result: RunResult): void {
  const lines: string[] = [];

  for (const r of result.results) {
    if (r.status === "failed") {
      const doc = r.failure?.doc;
      const file = doc?.file ?? r.failure?.generated.file ?? r.docFile;
      const line = doc?.line ?? r.failure?.generated.line ?? r.docLine ?? 1;
      const col = doc?.column ?? 1;
      const title = doc
        ? "Documentation example failed"
        : "Documentation example failed (unmapped)";
      const message = r.failure ? firstLine(r.failure.message) : "";
      lines.push(
        `::error file=${escapeProperty(file)},line=${line},col=${col},title=${escapeProperty(title)}::${escapeData(`${r.title} — ${message}`)}`,
      );
    } else if (r.status === "pending") {
      lines.push(
        `::notice file=${escapeProperty(r.docFile)},line=${r.docLine ?? 1},title=Pending example::${escapeData(r.title)}`,
      );
    }
  }

  if (result.junitMissing) {
    lines.push("::error title=metonym::test run did not complete cleanly");
    if (result.stderr) {
      for (const line of result.stderr.split("\n").slice(0, 20)) {
        lines.push(`::error::${escapeData(line)}`);
      }
    }
  }

  const t = result.totals;
  lines.push(
    `::notice title=metonym::${t.total} examples · ${t.passed} passed · ${t.failed} failed · ${t.pending} pending`,
  );

  process.stdout.write(`${lines.join("\n")}\n`);
}
