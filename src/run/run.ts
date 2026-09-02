/**
 * Test execution & failure remapping.
 * Spawns `bun test`, parses JUnit + stderr, remaps failures to doc locations.
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";
import type {
  DocumentationSet,
  ExampleResult,
  ExampleStatus,
  FailureInfo,
  GeneratedTest,
  RunResult,
  SidecarEntry,
} from "../ir/types";
import { parseExpectedReceived, parseJUnit, parseStackFrames } from "./junit";

export async function run(
  docs: DocumentationSet,
  opts?: { generated?: GeneratedTest[]; outDir?: string },
): Promise<RunResult> {
  const outDir = opts?.outDir ?? `${docs.root}/.metonym/tests`;
  const generated = opts?.generated ?? [];

  await syncGeneratedFiles(outDir, generated);

  const junitPath = `${outDir}/.junit.xml`;
  const proc = Bun.spawn(
    [
      "bun",
      "test",
      outDir,
      "--reporter=junit",
      `--reporter-outfile=${junitPath}`,
    ],
    {
      cwd: docs.root,
      stdout: "pipe",
      stderr: "pipe",
    },
  );

  const exitCode = await proc.exited;
  await new Response(proc.stderr).text();

  let junitText = "";
  try {
    junitText = await fs.readFile(junitPath, "utf-8");
  } catch {
    // JUnit file doesn't exist - treat all as skipped with stderr message
  }

  const junitCases = parseJUnit(junitText);

  // Sidecar entries come straight from the maps we just wrote — no need to
  // read them back from disk.
  type Entry = SidecarEntry & { path: string };
  const allEntries: Entry[] = [];
  for (const gt of generated) {
    for (const e of gt.map.entries) allEntries.push({ ...e, path: gt.path });
  }

  // Indexes so matching is linear in (cases + entries), not cases × entries.
  // Lists preserve allEntries order, which the original linear scans relied on.
  const byDocLine = new Map<number, Entry[]>();
  const byGenSpan = new Map<string, Entry[]>();
  const docLineById = new Map<string, number>();
  for (const entry of allEntries) {
    const lineList = byDocLine.get(entry.docCodeStartLine);
    if (lineList) lineList.push(entry);
    else byDocLine.set(entry.docCodeStartLine, [entry]);

    const spanKey = genSpanKey(entry);
    const spanList = byGenSpan.get(spanKey);
    if (spanList) spanList.push(entry);
    else byGenSpan.set(spanKey, [entry]);

    if (!docLineById.has(entry.exampleId)) {
      docLineById.set(entry.exampleId, entry.docCodeStartLine);
    }
  }
  const spanEntries = (entry: Entry): Entry[] =>
    byGenSpan.get(genSpanKey(entry)) ?? [entry];

  const exampleResults = new Map<string, ExampleResult>();
  const matchedEntryIds = new Set<string>();

  // Pass 1: match by name
  const namePatternRegex = /\(([^:]+):(\d+)\)$/;

  for (const junitCase of junitCases) {
    const nameMatch = namePatternRegex.exec(junitCase.name);
    if (!nameMatch) continue;

    const docFilePart = nameMatch[1];
    const docStartLine = parseInt(nameMatch[2], 10);

    let firstMatchingEntry: Entry | undefined;
    for (const entry of byDocLine.get(docStartLine) ?? []) {
      if (entry.docFile.endsWith(docFilePart)) {
        firstMatchingEntry = entry;
        break;
      }
    }

    if (firstMatchingEntry) {
      // First entry gets full failure info, others get status only
      let isFirst = true;
      for (const entry of spanEntries(firstMatchingEntry)) {
        let result: ExampleResult;
        if (isFirst) {
          result = buildExampleResult(junitCase, entry);
          isFirst = false;
        } else {
          result = {
            exampleId: entry.exampleId,
            title: entry.title,
            docFile: entry.docFile,
            status: mapStatus(junitCase.status),
            durationMs: junitCase.timeSec * 1000,
          };
        }
        exampleResults.set(entry.exampleId, result);
        matchedEntryIds.add(entry.exampleId);
      }
    }
  }

  // Pass 2: match by stack frames (failures only)
  for (const junitCase of junitCases) {
    if (
      junitCase.status === "passed" ||
      !junitCase.failure ||
      junitCase.status === "todo"
    ) {
      continue;
    }

    const frames = parseStackFrames(junitCase.failure.body);

    for (const frame of frames) {
      for (const entry of allEntries) {
        if (matchedEntryIds.has(entry.exampleId)) continue;

        if (
          frame.file.endsWith(entry.path) &&
          frame.line >= entry.genCodeStartLine &&
          frame.line <= entry.genCodeEndLine
        ) {
          const groupEntries = spanEntries(entry).filter(
            (e) => !matchedEntryIds.has(e.exampleId),
          );

          // First entry gets full failure info, others get status only
          let isFirst = true;
          for (const groupEntry of groupEntries) {
            let result: ExampleResult;
            if (isFirst) {
              result = buildExampleResult(junitCase, groupEntry, frame);
              isFirst = false;
            } else {
              result = {
                exampleId: groupEntry.exampleId,
                title: groupEntry.title,
                docFile: groupEntry.docFile,
                status: mapStatus(junitCase.status),
                durationMs: junitCase.timeSec * 1000,
              };
            }
            exampleResults.set(groupEntry.exampleId, result);
            matchedEntryIds.add(groupEntry.exampleId);
          }
          break;
        }
      }
    }
  }

  // Pass 3: unmatched → skipped
  for (const entry of allEntries) {
    if (!exampleResults.has(entry.exampleId)) {
      exampleResults.set(entry.exampleId, {
        exampleId: entry.exampleId,
        title: entry.title,
        docFile: entry.docFile,
        status: "skipped",
        durationMs: 0,
      });
    }
  }

  const results = Array.from(exampleResults.values()).sort((a, b) => {
    if (a.docFile !== b.docFile) {
      return a.docFile.localeCompare(b.docFile);
    }
    return (
      (docLineById.get(a.exampleId) ?? 0) - (docLineById.get(b.exampleId) ?? 0)
    );
  });

  const totals = {
    total: results.length,
    passed: 0,
    failed: 0,
    pending: 0,
    skipped: 0,
    durationMs: 0,
  };
  for (const r of results) {
    totals.durationMs += r.durationMs ?? 0;
    if (r.status === "passed") totals.passed++;
    else if (r.status === "failed") totals.failed++;
    else if (r.status === "pending") totals.pending++;
    else if (r.status === "skipped") totals.skipped++;
  }

  return {
    results,
    totals,
    outDir,
    exitCode,
  };
}

/**
 * Bring outDir in line with `generated` without wiping it first. Unchanged
 * files are left alone (an rm + full rewrite of 2000 docs' tests and maps
 * measured ~320ms; comparing and skipping is ~50ms), and anything not in
 * this run's set is deleted so stale tests never execute.
 */
async function syncGeneratedFiles(
  outDir: string,
  generated: GeneratedTest[],
): Promise<void> {
  await fs.mkdir(outDir, { recursive: true });

  const want = new Map<string, string>();
  for (const gt of generated) {
    const testPath = `${outDir}/${gt.path}`;
    want.set(testPath, gt.code);
    want.set(`${testPath}.map.json`, JSON.stringify(gt.map, null, 2));
  }

  const dirs = new Set<string>();
  for (const filePath of want.keys()) dirs.add(path.dirname(filePath));
  await Promise.all(
    Array.from(dirs, (dir) => fs.mkdir(dir, { recursive: true })),
  );

  await Promise.all(
    Array.from(want, async ([filePath, content]) => {
      const existing = Bun.file(filePath);
      if (existing.size === Buffer.byteLength(content)) {
        try {
          if ((await existing.text()) === content) return;
        } catch {
          // unreadable → rewrite
        }
      }
      await fs.writeFile(filePath, content, "utf-8");
    }),
  );

  let entries: import("node:fs").Dirent[];
  try {
    entries = await fs.readdir(outDir, {
      recursive: true,
      withFileTypes: true,
    });
  } catch {
    return;
  }
  await Promise.all(
    entries.map(async (entry) => {
      if (!entry.isFile()) return;
      const filePath = `${entry.parentPath}/${entry.name}`;
      if (want.has(filePath) || entry.name === ".junit.xml") return;
      await fs.unlink(filePath).catch(() => undefined);
    }),
  );
}

function genSpanKey(e: {
  path: string;
  genCodeStartLine: number;
  genCodeEndLine: number;
}): string {
  return `${e.path}\0${e.genCodeStartLine}\0${e.genCodeEndLine}`;
}

function buildExampleResult(
  junitCase: ReturnType<typeof parseJUnit>[0],
  entry: SidecarEntry & { path: string },
  failureFrame?: { fn?: string; file: string; line: number; column: number },
): ExampleResult {
  const result: ExampleResult = {
    exampleId: entry.exampleId,
    title: entry.title,
    docFile: entry.docFile,
    status: mapStatus(junitCase.status),
    durationMs: junitCase.timeSec * 1000,
  };

  if (junitCase.failure) {
    const { expected, received } = parseExpectedReceived(
      junitCase.failure.message,
    );
    const frames = parseStackFrames(junitCase.failure.body);

    let targetFrame: (typeof frames)[0] | undefined;

    if (failureFrame) {
      targetFrame = failureFrame;
    } else {
      for (const frame of frames) {
        if (
          frame.line >= entry.genCodeStartLine &&
          frame.line <= entry.genCodeEndLine
        ) {
          targetFrame = frame;
          break;
        }
      }
    }

    const failure: FailureInfo = {
      message: junitCase.failure.message,
      expected,
      received,
      generated: {
        file: entry.path,
        line: targetFrame?.line,
        column: targetFrame?.column,
      },
    };

    if (targetFrame) {
      const docLine =
        entry.docCodeStartLine + (targetFrame.line - entry.genCodeStartLine);
      failure.doc = {
        file: entry.docFile,
        line: docLine,
        column: targetFrame.column,
      };
    }

    result.failure = failure;
  }

  return result;
}

function mapStatus(junitStatus: string): ExampleStatus {
  switch (junitStatus) {
    case "passed":
      return "passed";
    case "failed":
      return "failed";
    case "todo":
      return "pending";
    case "skipped":
      return "skipped";
    default:
      return "skipped";
  }
}
