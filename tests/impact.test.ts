import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type DocumentationSet, extract, scan } from "metonym";
import {
  computeImpact,
  impactGraph,
  renderImpactTree,
} from "../src/graph/impact";

let tmpDir: string;
let docs: DocumentationSet;

beforeAll(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), "impact-test-"));

  await Bun.write(
    join(tmpDir, "package.json"),
    JSON.stringify({
      name: "imp-pkg",
      exports: { ".": "./src/index.ts" },
    }),
  );

  await Bun.write(
    join(tmpDir, "src/deep.ts"),
    "export function deepFn() { return 42; }\n",
  );

  await Bun.write(
    join(tmpDir, "src/util.ts"),
    `import { deepFn } from "./deep";
export function helper() { return deepFn(); }
`,
  );

  await Bun.write(
    join(tmpDir, "src/index.ts"),
    `import { helper } from "./util";
export function add(a: number, b: number) { return a + b; }
export { helper };
`,
  );

  const readmeContent = `# My Package

\`\`\`ts
import { add } from "imp-pkg"
expect(add(2, 3)).toBe(5)
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
});

afterAll(async () => {
  if (tmpDir) {
    await rm(tmpDir, { recursive: true, force: true });
  }
});

test("computeImpact(): changed [src/deep.ts] → README example affected with reason 'imports'", async () => {
  const impact = await computeImpact(docs, ["src/deep.ts"]);

  const readmeExample = docs.examples.find(
    (ex) => ex.source.file === "README.md",
  );
  expect(readmeExample).toBeDefined();

  if (readmeExample) {
    expect(impact.affectedExamples).toContain(readmeExample.id);

    const trace = impact.traces.find((t) => t.exampleId === readmeExample.id);
    expect(trace).toBeDefined();
    if (trace) {
      expect(trace.reason).toBe("imports");
      expect(trace.changedFile).toBe("src/deep.ts");
      expect(trace.path.length).toBeGreaterThan(0);
      expect(trace.path[0]).toBe("src/index.ts"); // entry file
      expect(trace.path[trace.path.length - 1]).toBe("src/deep.ts"); // changed file
    }
  }
});

test("computeImpact(): changed [src/deep.ts] → docs/other.md example NOT affected", async () => {
  const impact = await computeImpact(docs, ["src/deep.ts"]);

  const otherExample = docs.examples.find(
    (ex) => ex.source.file === "docs/other.md",
  );
  expect(otherExample).toBeDefined();

  if (otherExample) {
    expect(impact.affectedExamples).not.toContain(otherExample.id);
  }
});

test("computeImpact(): changed [docs/other.md] → only that example affected with reason 'doc-changed'", async () => {
  const impact = await computeImpact(docs, ["docs/other.md"]);

  const otherExample = docs.examples.find(
    (ex) => ex.source.file === "docs/other.md",
  );
  expect(otherExample).toBeDefined();

  if (otherExample) {
    expect(impact.affectedExamples).toContain(otherExample.id);

    const trace = impact.traces.find((t) => t.exampleId === otherExample.id);
    expect(trace).toBeDefined();
    if (trace) {
      expect(trace.reason).toBe("doc-changed");
      expect(trace.changedFile).toBe("docs/other.md");
      expect(trace.path).toEqual([]); // doc-changed has empty path
    }
  }

  const readmeExample = docs.examples.find(
    (ex) => ex.source.file === "README.md",
  );
  if (readmeExample) {
    expect(impact.affectedExamples).not.toContain(readmeExample.id);
  }
});

test("computeImpact(): changed [package.json] → ALL examples with reason 'config-changed'", async () => {
  const impact = await computeImpact(docs, ["package.json"]);

  expect(impact.affectedExamples.length).toBe(docs.examples.length);

  for (const trace of impact.traces) {
    expect(trace.reason).toBe("config-changed");
    expect(trace.changedFile).toBe("package.json");
    expect(trace.path).toEqual([]);
  }
});

test("computeImpact(): changedFiles field contains input", async () => {
  const impact = await computeImpact(docs, ["src/deep.ts", "docs/other.md"]);

  expect(impact.changedFiles).toContain("src/deep.ts");
  expect(impact.changedFiles).toContain("docs/other.md");
});

test("computeImpact(): traces sorted by (docFile, exampleId, changedFile)", async () => {
  const impact = await computeImpact(docs, ["src/deep.ts", "docs/other.md"]);

  for (let i = 1; i < impact.traces.length; i++) {
    const prev = impact.traces[i - 1];
    const curr = impact.traces[i];

    const docCmp = prev.docFile.localeCompare(curr.docFile);
    if (docCmp !== 0) {
      expect(docCmp).toBeLessThan(0);
    } else {
      const exCmp = prev.exampleId.localeCompare(curr.exampleId);
      if (exCmp !== 0) {
        expect(exCmp).toBeLessThan(0);
      } else {
        expect(
          prev.changedFile.localeCompare(curr.changedFile),
        ).toBeLessThanOrEqual(0);
      }
    }
  }
});

test("computeImpact(): affectedExamples are deduped and sorted", async () => {
  const impact = await computeImpact(docs, ["src/deep.ts"]);

  for (let i = 1; i < impact.affectedExamples.length; i++) {
    expect(
      impact.affectedExamples[i - 1].localeCompare(impact.affectedExamples[i]),
    ).toBeLessThanOrEqual(0);
  }

  const set = new Set(impact.affectedExamples);
  expect(set.size).toBe(impact.affectedExamples.length);
});

test("computeImpact(): affectedDocs are deduped and sorted", async () => {
  const impact = await computeImpact(docs, ["src/deep.ts", "docs/other.md"]);

  for (let i = 1; i < impact.affectedDocs.length; i++) {
    expect(
      impact.affectedDocs[i - 1].localeCompare(impact.affectedDocs[i]),
    ).toBeLessThanOrEqual(0);
  }

  const set = new Set(impact.affectedDocs);
  expect(set.size).toBe(impact.affectedDocs.length);
});

test("impactGraph(): deep.ts case → nodes and edges present", async () => {
  const impact = await computeImpact(docs, ["src/deep.ts"]);
  const graph = impactGraph(docs, impact);

  const changedNode = graph.nodes.find((n) => n.id === "mod:src/deep.ts");
  expect(changedNode).toBeDefined();
  expect(changedNode?.label).toContain("(changed)");

  const utilNode = graph.nodes.find((n) => n.id === "mod:src/util.ts");
  expect(utilNode).toBeDefined();

  const indexNode = graph.nodes.find((n) => n.id === "mod:src/index.ts");
  expect(indexNode).toBeDefined();

  const readmeExample = docs.examples.find(
    (ex) => ex.source.file === "README.md",
  );
  if (readmeExample) {
    const exampleNode = graph.nodes.find((n) => n.id === readmeExample.id);
    expect(exampleNode).toBeDefined();
  }

  const readmeDoc = docs.documents.find((d) => d.file === "README.md");
  if (readmeDoc) {
    const docNode = graph.nodes.find((n) => n.id === readmeDoc.id);
    expect(docNode).toBeDefined();
  }
});

test("impactGraph(): edges point in correct direction (reversed)", async () => {
  const impact = await computeImpact(docs, ["src/deep.ts"]);
  const graph = impactGraph(docs, impact);

  const deepToUtilEdge = graph.edges.find(
    (e) => e.from === "mod:src/deep.ts" && e.to === "mod:src/util.ts",
  );
  expect(deepToUtilEdge).toBeDefined();

  const utilToIndexEdge = graph.edges.find(
    (e) => e.from === "mod:src/util.ts" && e.to === "mod:src/index.ts",
  );
  expect(utilToIndexEdge).toBeDefined();
});

test("impactGraph(): entry to example edge", async () => {
  const impact = await computeImpact(docs, ["src/deep.ts"]);
  const graph = impactGraph(docs, impact);

  const readmeExample = docs.examples.find(
    (ex) => ex.source.file === "README.md",
  );
  if (readmeExample) {
    const entryToExEdge = graph.edges.find(
      (e) => e.from === "mod:src/index.ts" && e.to === readmeExample.id,
    );
    expect(entryToExEdge).toBeDefined();
    expect(entryToExEdge?.kind).toBe("imports");
  }
});

test("impactGraph(): example to document edge", async () => {
  const impact = await computeImpact(docs, ["src/deep.ts"]);
  const graph = impactGraph(docs, impact);

  const readmeExample = docs.examples.find(
    (ex) => ex.source.file === "README.md",
  );
  const readmeDoc = docs.documents.find((d) => d.file === "README.md");

  if (readmeExample && readmeDoc) {
    const exToDocEdge = graph.edges.find(
      (e) => e.from === readmeExample.id && e.to === readmeDoc.id,
    );
    expect(exToDocEdge).toBeDefined();
    expect(exToDocEdge?.kind).toBe("contains");
  }
});

test("impactGraph(): nodes sorted by id", async () => {
  const impact = await computeImpact(docs, ["src/deep.ts"]);
  const graph = impactGraph(docs, impact);

  for (let i = 1; i < graph.nodes.length; i++) {
    expect(
      graph.nodes[i - 1].id.localeCompare(graph.nodes[i].id),
    ).toBeLessThanOrEqual(0);
  }
});

test("impactGraph(): edges sorted by (from, to)", async () => {
  const impact = await computeImpact(docs, ["src/deep.ts"]);
  const graph = impactGraph(docs, impact);

  for (let i = 1; i < graph.edges.length; i++) {
    const prev = graph.edges[i - 1];
    const curr = graph.edges[i];

    const fromCmp = prev.from.localeCompare(curr.from);
    if (fromCmp !== 0) {
      expect(fromCmp).toBeLessThan(0);
    } else {
      expect(prev.to.localeCompare(curr.to)).toBeLessThanOrEqual(0);
    }
  }
});

test("impactGraph(): deterministic across multiple calls", async () => {
  const impact = await computeImpact(docs, ["src/deep.ts"]);

  const graph1 = impactGraph(docs, impact);
  const graph2 = impactGraph(docs, impact);

  expect(JSON.stringify(graph1)).toBe(JSON.stringify(graph2));
});

test("impactGraph(): should contain changed node and edges for Mermaid serialization", async () => {
  const impact = await computeImpact(docs, ["src/deep.ts"]);
  const graph = impactGraph(docs, impact);

  const changedNode = graph.nodes.find((n) => n.id === "mod:src/deep.ts");
  expect(changedNode).toBeDefined();
  expect(changedNode?.label).toContain("changed");

  expect(graph.edges.length).toBeGreaterThan(0);

  const exampleNode = graph.nodes.find((n) => n.type === "example");
  expect(exampleNode).toBeDefined();
});

test("renderImpactTree(): contains changed-file header", async () => {
  const impact = await computeImpact(docs, ["src/deep.ts"]);
  const tree = renderImpactTree(impact);

  expect(tree).toContain("src/deep.ts changed");
});

test("renderImpactTree(): contains chain line with →", async () => {
  const impact = await computeImpact(docs, ["src/deep.ts"]);
  const tree = renderImpactTree(impact);

  expect(tree).toContain("→");
});

test("renderImpactTree(): contains example line with › ", async () => {
  const impact = await computeImpact(docs, ["src/deep.ts"]);
  const tree = renderImpactTree(impact);

  expect(tree).toContain("›");
});

test("renderImpactTree(): contains summary line with example and doc counts", async () => {
  const impact = await computeImpact(docs, ["src/deep.ts"]);
  const tree = renderImpactTree(impact);

  const exCount = impact.affectedExamples.length;
  const docCount = impact.affectedDocs.length;
  expect(tree).toContain(
    `${exCount} example(s) affected across ${docCount} documentation file(s)`,
  );
});

test("renderImpactTree(): doc-changed shows documentation in header", async () => {
  const impact = await computeImpact(docs, ["docs/other.md"]);
  const tree = renderImpactTree(impact);

  expect(tree).toContain("docs/other.md changed (documentation)");
});

test("renderImpactTree(): config-changed shows config in header and all examples affected", async () => {
  const impact = await computeImpact(docs, ["package.json"]);
  const tree = renderImpactTree(impact);

  expect(tree).toContain("package.json changed (config)");
  expect(tree).toContain("all examples affected");
});

test("renderImpactTree(): deterministic output", async () => {
  const impact = await computeImpact(docs, ["src/deep.ts"]);

  const tree1 = renderImpactTree(impact);
  const tree2 = renderImpactTree(impact);

  expect(tree1).toBe(tree2);
});

test("computeImpact(): multiple changed files", async () => {
  const impact = await computeImpact(docs, ["src/util.ts", "docs/other.md"]);

  expect(impact.changedFiles).toContain("src/util.ts");
  expect(impact.changedFiles).toContain("docs/other.md");

  expect(impact.traces.length).toBeGreaterThan(0);

  const hasUtil = impact.traces.some((t) => t.changedFile === "src/util.ts");
  const hasOther = impact.traces.some((t) => t.changedFile === "docs/other.md");

  expect(hasUtil || hasOther).toBe(true);
});

test("computeImpact(): typeErrorCounts surfaces error-severity diagnostics on affected examples", async () => {
  const loc = {
    file: "README.md",
    start: { line: 1, column: 1, offset: 0 },
    end: { line: 1, column: 1, offset: 0 },
  };
  const errDocs: DocumentationSet = {
    irVersion: 1,
    tool: { name: "metonym", version: "0.1.0" },
    root: "/tmp/impact-diag-test",
    documents: [
      {
        id: "doc:README.md",
        file: "README.md",
        origin: "readme",
        exampleIds: ["ex:1", "ex:2"],
      },
    ],
    examples: [
      {
        id: "ex:1",
        documentId: "doc:README.md",
        source: loc,
        fenceSource: loc,
        language: "ts",
        code: 'const bad = add("x", 2);',
        kind: "assertion",
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
      },
      {
        id: "ex:2",
        documentId: "doc:README.md",
        source: loc,
        fenceSource: loc,
        language: "ts",
        code: "const ok = 1;",
        kind: "assertion",
        title: "clean",
      },
    ],
    symbols: [],
    relations: [],
  };

  const impact = await computeImpact(errDocs, ["README.md"]);

  expect(impact.typeErrorCounts).toEqual({ "ex:1": 1 });
  expect(impact.typeErrorCounts["ex:2"]).toBeUndefined();

  const tree = renderImpactTree(impact);
  expect(tree).toContain("broken ⚠ 1 type error(s)");
  expect(tree).not.toContain("clean ⚠");
  expect(tree).toContain("1 with type errors");
});

test("impactGraph(): no duplicate edges", async () => {
  const impact = await computeImpact(docs, ["src/deep.ts"]);
  const graph = impactGraph(docs, impact);

  const edgeKeys = new Set<string>();
  for (const edge of graph.edges) {
    const key = `${edge.from}|${edge.to}`;
    expect(edgeKeys.has(key)).toBe(false);
    edgeKeys.add(key);
  }

  expect(edgeKeys.size).toBe(graph.edges.length);
});
