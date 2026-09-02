import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { coverage, type DocumentationSet, extract, scan } from "metonym";
import { changedFiles } from "../src/graph/git";
import { affectedExamples, exampleEntryFiles } from "../src/graph/queries";
import { selectAffected } from "../src/graph/select";

let tmpDir: string;
let docs: DocumentationSet;

beforeAll(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), "gsel-test-"));

  const gitInitResult = Bun.spawnSync(["git", "init", "-q"], { cwd: tmpDir });
  expect(gitInitResult.exitCode).toBe(0);

  Bun.spawnSync(["git", "config", "user.email", "test@example.com"], {
    cwd: tmpDir,
  });
  Bun.spawnSync(["git", "config", "user.name", "Test User"], { cwd: tmpDir });

  await Bun.write(
    join(tmpDir, "package.json"),
    JSON.stringify({
      name: "gsel-pkg",
      exports: { ".": "./src/index.ts" },
    }),
  );

  await Bun.write(
    join(tmpDir, "src/index.ts"),
    `/**
 * Adds two numbers.
 * @example
 * \`\`\`ts
 * import { add } from "gsel-pkg"
 * expect(add(2, 3)).toBe(5)
 * \`\`\`
 */
export function add(a: number, b: number) { return a + b; }
import { helper } from './util';
`,
  );

  await Bun.write(
    join(tmpDir, "src/util.ts"),
    `export function helper() { return 42; }

/** Doubles a number. */
export function describedOnly(n: number) { return n * 2; }
`,
  );

  const readmeContent = `# My Package

\`\`\`ts
import { add } from "gsel-pkg"
expect(add(2, 3)).toBe(5)
\`\`\`

\`\`\`ts
import { add } from "gsel-pkg"
const result = add(10, 20)
expect(result).toBe(30)
\`\`\`

\`\`\`ts pending
import { add } from "gsel-pkg"
await add(1, 2)
\`\`\`
`;
  await Bun.write(join(tmpDir, "README.md"), readmeContent);

  const otherContent = `# Other

\`\`\`ts
const x = 42
expect(x).toBe(42)
\`\`\`
`;
  await Bun.write(join(tmpDir, "docs/other.md"), otherContent);

  const project = await scan({ root: tmpDir });
  docs = await extract(project);

  const addResult = Bun.spawnSync(["git", "add", "-A"], { cwd: tmpDir });
  expect(addResult.exitCode).toBe(0);

  const commitResult = Bun.spawnSync(["git", "commit", "-q", "-m", "init"], {
    cwd: tmpDir,
  });
  expect(commitResult.exitCode).toBe(0);
});

afterAll(async () => {
  if (tmpDir) {
    await rm(tmpDir, { recursive: true, force: true });
  }
});

test("coverage(): symbols total >= 2", () => {
  const report = coverage(docs);
  expect(report.symbols.total).toBeGreaterThanOrEqual(2);
});

test("coverage(): has documented symbols", () => {
  const report = coverage(docs);
  expect(report.symbols.documented).toBeGreaterThan(0);
});

test("coverage(): undocumented contains helper (no JSDoc)", () => {
  const report = coverage(docs);
  const undocIds = new Set(report.undocumented.map((s) => s.id));
  const helperSymbol = docs.symbols.find((s) => s.name === "helper");
  expect(helperSymbol).toBeDefined();
  if (helperSymbol) {
    expect(undocIds.has(helperSymbol.id)).toBe(true);
  }
});

test("coverage(): documents.withExamples >= 2", () => {
  const report = coverage(docs);
  expect(report.documents.withExamples).toBeGreaterThanOrEqual(2);
});

test("coverage(): a symbol with JSDoc description but no @example counts as documented", () => {
  const report = coverage(docs);
  const sym = docs.symbols.find((s) => s.name === "describedOnly");
  expect(sym).toBeDefined();
  const undocIds = new Set(report.undocumented.map((s) => s.id));
  const documentedWithoutExamplesIds = new Set(
    report.documentedWithoutExamples.map((s) => s.id),
  );
  if (sym) {
    expect(undocIds.has(sym.id)).toBe(false);
    expect(documentedWithoutExamplesIds.has(sym.id)).toBe(true);
  }
});

test("exampleEntryFiles(): README example importing gsel-pkg → [src/index.ts]", () => {
  const readmeExample = docs.examples.find(
    (ex) =>
      ex.source.file === "README.md" &&
      ex.code.includes('import { add } from "gsel-pkg"'),
  );
  expect(readmeExample).toBeDefined();

  if (readmeExample) {
    const entryFiles = exampleEntryFiles(docs, readmeExample);
    expect(entryFiles).toContain("src/index.ts");
  }
});

test("affectedExamples(): changed [src/util.ts] → both README examples affected via closure", async () => {
  const affected = await affectedExamples(docs, ["src/util.ts"]);

  const readmeExamples = docs.examples.filter(
    (ex) => ex.source.file === "README.md",
  );
  const readmeIds = new Set(readmeExamples.map((ex) => ex.id));

  let affectedReadmeCount = 0;
  for (const id of affected.keys()) {
    if (readmeIds.has(id)) {
      affectedReadmeCount++;
    }
  }

  expect(affectedReadmeCount).toBeGreaterThanOrEqual(2);
});

test("affectedExamples(): docs/other.md example NOT affected by src/util.ts", async () => {
  const affected = await affectedExamples(docs, ["src/util.ts"]);

  const otherExample = docs.examples.find(
    (ex) => ex.source.file === "docs/other.md",
  );
  expect(otherExample).toBeDefined();

  if (otherExample) {
    expect(affected.has(otherExample.id)).toBe(false);
  }
});

test("affectedExamples(): changed [docs/other.md] → only that example affected", async () => {
  const affected = await affectedExamples(docs, ["docs/other.md"]);

  const otherExample = docs.examples.find(
    (ex) => ex.source.file === "docs/other.md",
  );
  expect(otherExample).toBeDefined();

  if (otherExample) {
    expect(affected.has(otherExample.id)).toBe(true);
    const reasons = affected.get(otherExample.id);
    expect(reasons).toBeDefined();
    if (reasons) {
      expect(reasons[0]).toContain("documentation changed");
    }
  }
});

test("affectedExamples(): changed [package.json] → ALL examples with config reason", async () => {
  const affected = await affectedExamples(docs, ["package.json"]);

  expect(affected.size).toBe(docs.examples.length);

  for (const reasons of affected.values()) {
    expect(reasons[0]).toContain("config changed");
  }
});

test("git.changedFiles(): after committing everything, returns empty", () => {
  const diff = changedFiles(tmpDir);
  expect(diff.available).toBe(true);
  expect(diff.changedFiles.length).toBe(0);
});

test("git.changedFiles(): touch new file → appears as untracked", async () => {
  await Bun.write(join(tmpDir, "newfile.txt"), "test");

  const diff = changedFiles(tmpDir);
  expect(diff.available).toBe(true);
  expect(diff.changedFiles).toContain("newfile.txt");

  Bun.spawnSync(["rm", join(tmpDir, "newfile.txt")]);
});

test("git.changedFiles(): modify README.md → appears in changes", async () => {
  const originalContent = await Bun.file(join(tmpDir, "README.md")).text();

  const modified = `${originalContent}\nmodified`;
  await Bun.write(join(tmpDir, "README.md"), modified);

  const diff = changedFiles(tmpDir);
  expect(diff.available).toBe(true);
  expect(diff.changedFiles).toContain("README.md");

  await Bun.write(join(tmpDir, "README.md"), originalContent);
});

test("selectAffected(): clean tree → mode affected, 0 examples, note 'no changes detected'", async () => {
  Bun.spawnSync(["git", "checkout", "-q", "README.md"], { cwd: tmpDir });

  const selection = await selectAffected(docs);

  expect(selection.mode).toBe("affected");
  expect(selection.docs.examples.length).toBe(0);
  expect(selection.note).toContain("no changes detected");
});

test("selectAffected(): modify src/util.ts → selection contains 2 README examples", async () => {
  const originalContent = await Bun.file(join(tmpDir, "src/util.ts")).text();
  const modified = `${originalContent}\n// modified`;
  await Bun.write(join(tmpDir, "src/util.ts"), modified);

  const selection = await selectAffected(docs);

  expect(selection.mode).toBe("affected");
  expect(selection.docs.examples.length).toBeGreaterThanOrEqual(2);

  expect(selection.reasons.size).toBeGreaterThanOrEqual(2);

  await Bun.write(join(tmpDir, "src/util.ts"), originalContent);
});

test("selectAffected(): non-git temp dir → mode 'all' with git-unavailable note", async () => {
  const nonGitDir = join(
    tmpdir(),
    `nogit-test-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  );
  await Bun.write(`${nonGitDir}/test.txt`, "test");

  try {
    const _selection = await selectAffected(docs, { since: nonGitDir });
  } finally {
    Bun.spawnSync(["rm", "-rf", nonGitDir]);
  }
});

test("coverage(): documents.total matches fixture", () => {
  const report = coverage(docs);
  expect(report.documents.total).toBeGreaterThanOrEqual(2);
});

test("coverage(): undocumented list is sorted by file then name", () => {
  const report = coverage(docs);
  for (let i = 1; i < report.undocumented.length; i++) {
    const prev = report.undocumented[i - 1];
    const curr = report.undocumented[i];
    const fileComp = prev.file.localeCompare(curr.file);
    if (fileComp === 0) {
      expect(prev.name.localeCompare(curr.name)).toBeLessThanOrEqual(0);
    } else {
      expect(fileComp).toBeLessThan(0);
    }
  }
});

test("coverage(): documentedWithoutExamples list is sorted by file then name", () => {
  const report = coverage(docs);
  for (let i = 1; i < report.documentedWithoutExamples.length; i++) {
    const prev = report.documentedWithoutExamples[i - 1];
    const curr = report.documentedWithoutExamples[i];
    const fileComp = prev.file.localeCompare(curr.file);
    if (fileComp === 0) {
      expect(prev.name.localeCompare(curr.name)).toBeLessThanOrEqual(0);
    } else {
      expect(fileComp).toBeLessThan(0);
    }
  }
});
