/**
 * End-to-end ostia benches for scan → extract → generate.
 * Generates each synthetic repo once before registration, then benches the
 * three verbs separately. Does not execute examples.
 */

import { group, task } from "ostia";
import { generate } from "../src/emit/generate";
import {
  assembleDocumentationSet,
  extract,
  extractDocFile,
  extractSourceFile,
  type FilePart,
} from "../src/extract";
import type { DocumentationSet, Project } from "../src/ir/types";
import { scanDecls } from "../src/parse/decls";
import {
  extractDocComments,
  extractJsdoc,
  extractJsdocBlocks,
} from "../src/parse/jsdoc";
import { extractMarkdown } from "../src/parse/markdown";
import { scanSymbols } from "../src/parse/symbols";
import { scan } from "../src/scan/scan";
import { generateRepo } from "./gen";

type Size = "S" | "M";

interface Prepared {
  size: Size;
  root: string;
  project: Project;
  docs: DocumentationSet;
  parts: FilePart[];
}

async function rmRecursive(path: string): Promise<void> {
  await Bun.spawn(["rm", "-rf", path], {
    stdio: ["ignore", "ignore", "ignore"],
  }).exited;
}

async function collectParts(project: Project): Promise<FilePart[]> {
  const { root } = project;
  const languages = project.config.languages;
  const [docParts, sourceParts] = await Promise.all([
    Promise.all(
      project.docFiles.map((file) => extractDocFile(root, file, languages)),
    ),
    Promise.all(
      project.sourceFiles.map((file) =>
        extractSourceFile(root, file, languages),
      ),
    ),
  ]);
  return [...docParts, ...sourceParts];
}

async function timeExtractSubphases(project: Project): Promise<void> {
  const { root } = project;
  const languages = project.config.languages;

  const tRead0 = performance.now();
  const docTexts = await Promise.all(
    project.docFiles.map(async (file) => ({
      file,
      text: await Bun.file(`${root}/${file}`).text(),
    })),
  );
  const srcTexts = await Promise.all(
    project.sourceFiles.map(async (file) => ({
      file,
      text: await Bun.file(`${root}/${file}`).text(),
    })),
  );
  const tRead = performance.now() - tRead0;

  const tMd0 = performance.now();
  const docParts: FilePart[] = docTexts.map(({ file, text }) => {
    const { document, examples } = extractMarkdown(text, { file, languages });
    return { file, document, examples, symbols: [] };
  });
  const tMarkdown = performance.now() - tMd0;

  const tJsdoc0 = performance.now();
  const jsdocged = srcTexts.map(({ file, text }) => {
    const blocks = extractJsdocBlocks(text);
    const { document, examples } = extractJsdoc(text, {
      file,
      languages,
      blocks,
    });
    return { file, text, blocks, document, examples };
  });
  const tJsdoc = performance.now() - tJsdoc0;

  const tSym0 = performance.now();
  const withSymbols = jsdocged.map((r) => ({
    ...r,
    symbols: scanSymbols(r.file, r.text),
  }));
  const tSymbols = performance.now() - tSym0;

  // Nested: scanDecls is already inside scanSymbols. Timed separately so
  // we can see its share. Do not add this into cpu sum.
  const tDecls0 = performance.now();
  for (const r of jsdocged) scanDecls(r.text);
  const tDecls = performance.now() - tDecls0;

  const tCom0 = performance.now();
  const sourceParts: FilePart[] = withSymbols.map((r) => {
    const byName = new Map(r.symbols.map((s) => [s.name, s]));
    for (const dc of extractDocComments(r.text, {
      file: r.file,
      blocks: r.blocks,
    })) {
      if (!dc.declName) continue;
      const sym = byName.get(dc.declName);
      if (!sym) continue;
      if (dc.description) sym.description = dc.description;
      if (Object.keys(dc.tags).length > 0) sym.tags = dc.tags;
    }
    return {
      file: r.file,
      document: r.document,
      examples: r.examples,
      symbols: r.symbols,
    };
  });
  const tComments = performance.now() - tCom0;

  const tAs0 = performance.now();
  assembleDocumentationSet(root, [...docParts, ...sourceParts]);
  const tAssemble = performance.now() - tAs0;

  const row = (name: string, ms: number) =>
    console.log(`  ${name.padEnd(16)} ${ms.toFixed(2)}`);

  row("read", tRead);
  row("markdown", tMarkdown);
  row("jsdoc", tJsdoc);
  row("scanSymbols", tSymbols);
  row("  scanDecls", tDecls);
  row("comments", tComments);
  row("assemble", tAssemble);
  row("cpu sum", tMarkdown + tJsdoc + tSymbols + tComments + tAssemble);
}

const SIZES: Size[] = ["S", "M"];
const prepared: Prepared[] = [];

for (const size of SIZES) {
  const root = `${import.meta.dir}/tmp/repo-${size}`;
  await rmRecursive(root);
  await generateRepo(root, size);
  const project = await scan({ root });
  const parts = await collectParts(project);
  const docs = assembleDocumentationSet(project.root, parts);
  prepared.push({ size, root, project, docs, parts });
}

for (const { size, root, project, docs, parts } of prepared) {
  group(`pipeline ${size}`, () => {
    task("scan", async () => scan({ root }));
    task("extract", async () => extract(project));
    task("assemble", () => assembleDocumentationSet(project.root, parts));
    task("generate", () => generate(docs));
  });
}

console.log("\nphase breakdown (single run, ms):");
for (const { size, root } of prepared) {
  const t0 = performance.now();
  const project = await scan({ root });
  const t1 = performance.now();
  const docs = await extract(project);
  const t2 = performance.now();
  generate(docs);
  const t3 = performance.now();

  console.log(`Size ${size}`);
  console.log(`  ${"scan".padEnd(16)} ${(t1 - t0).toFixed(2)}`);
  console.log(`  ${"extract".padEnd(16)} ${(t2 - t1).toFixed(2)}`);
  console.log(`  ${"generate".padEnd(16)} ${(t3 - t2).toFixed(2)}`);
  console.log(`  ${"total".padEnd(16)} ${(t3 - t0).toFixed(2)}`);
}

console.log("\nextract subphases (single run, ms):");
for (const { size, project } of prepared) {
  console.log(`Size ${size}`);
  await timeExtractSubphases(project);
}
