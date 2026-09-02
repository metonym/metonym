import { describe, expect, it } from "bun:test";
import { type DocumentationSet, toMermaid } from "metonym";
import { buildGraph, toDot, toGraphJSON } from "../src/graph/emit";

const testDocs: DocumentationSet = {
  irVersion: 1,
  tool: { name: "metonym", version: "0.1.0" },
  root: "/tmp/x",
  documents: [
    {
      id: "doc:README.md",
      file: "README.md",
      origin: "readme",
      title: "Example Doc",
      exampleIds: ["ex:README.md:abc123d0", "ex:README.md:def456a1"],
    },
  ],
  examples: [
    {
      id: "ex:README.md:abc123d0",
      documentId: "doc:README.md",
      source: {
        file: "README.md",
        start: { line: 5, column: 1, offset: 45 },
        end: { line: 7, column: 1, offset: 95 },
      },
      fenceSource: {
        file: "README.md",
        start: { line: 4, column: 1, offset: 30 },
        end: { line: 8, column: 1, offset: 100 },
      },
      language: "ts",
      code: "expect(1).toBe(1)",
      kind: "assertion",
      title: 'Example › "quoted" example',
      owner: undefined,
    },
    {
      id: "ex:README.md:def456a1",
      documentId: "doc:README.md",
      source: {
        file: "README.md",
        start: { line: 15, column: 1, offset: 150 },
        end: { line: 17, column: 1, offset: 200 },
      },
      fenceSource: {
        file: "README.md",
        start: { line: 14, column: 1, offset: 140 },
        end: { line: 18, column: 1, offset: 210 },
      },
      language: "ts",
      code: "expect(2).toBe(2)",
      kind: "assertion",
      title: 'Example › unicode "🎉" example',
      owner: undefined,
    },
  ],
  symbols: [
    {
      id: "sym:src/util.ts:add",
      file: "src/util.ts",
      name: "add",
      imports: [
        { path: "pkg-name", kind: "default" },
        { path: "./util", kind: "named" },
      ],
    },
  ],
  relations: [
    // contains: document → example
    { kind: "contains", from: "doc:README.md", to: "ex:README.md:abc123d0" },
    { kind: "contains", from: "doc:README.md", to: "ex:README.md:def456a1" },
    // documents: document → symbol
    { kind: "documents", from: "doc:README.md", to: "sym:src/util.ts:add" },
    // owns: symbol → example
    {
      kind: "owns",
      from: "sym:src/util.ts:add",
      to: "ex:README.md:abc123d0",
    },
    // imports: example → module path
    {
      kind: "imports",
      from: "ex:README.md:def456a1",
      to: "pkg-name",
    },
    // imports: symbol → module path
    {
      kind: "imports",
      from: "sym:src/util.ts:add",
      to: "./util",
    },
  ],
};

describe("graph emit", () => {
  describe("buildGraph", () => {
    it("creates correct number of nodes", () => {
      const { nodes } = buildGraph(testDocs);
      // 1 document + 2 examples + 1 symbol + 2 modules = 6 nodes
      expect(nodes.length).toBe(6);
    });

    it("includes all node types", () => {
      const { nodes } = buildGraph(testDocs);
      const types = new Set(nodes.map((n) => n.type));
      expect(types).toEqual(
        new Set(["document", "example", "symbol", "module"]),
      );
    });

    it("creates module nodes for imports", () => {
      const { nodes } = buildGraph(testDocs);
      const moduleIds = nodes
        .filter((n) => n.type === "module")
        .map((n) => n.id);
      expect(moduleIds).toContain("mod:pkg-name");
      expect(moduleIds).toContain("mod:./util");
    });

    it("rewrites imports edges to mod: ids", () => {
      const { edges } = buildGraph(testDocs);
      const importEdges = edges.filter((e) => e.kind === "imports");
      expect(importEdges.length).toBe(2);

      for (const edge of importEdges) {
        expect(edge.to).toMatch(/^mod:/);
      }
    });

    it("deduplicates edges", () => {
      const docsDuplicate: DocumentationSet = {
        ...testDocs,
        relations: [
          ...testDocs.relations,
          {
            kind: "contains",
            from: "doc:README.md",
            to: "ex:README.md:abc123d0",
          },
        ],
      };
      const { edges } = buildGraph(docsDuplicate);
      const containsEdges = edges.filter((e) => e.kind === "contains");
      expect(containsEdges.length).toBe(2);
    });

    it("sorts nodes by id", () => {
      const { nodes } = buildGraph(testDocs);
      const ids = nodes.map((n) => n.id);
      const sortedIds = [...ids].sort();
      expect(ids).toEqual(sortedIds);
    });

    it("sorts edges by (kind, from, to)", () => {
      const { edges } = buildGraph(testDocs);
      for (let i = 0; i < edges.length - 1; i++) {
        const current = edges[i];
        const next = edges[i + 1];
        const kindCmp = current.kind.localeCompare(next.kind);
        if (kindCmp !== 0) {
          expect(kindCmp).toBeLessThan(0);
        } else {
          const fromCmp = current.from.localeCompare(next.from);
          if (fromCmp !== 0) {
            expect(fromCmp).toBeLessThan(0);
          } else {
            expect(current.to.localeCompare(next.to)).toBeLessThanOrEqual(0);
          }
        }
      }
    });

    it("is deterministic (deep equal on multiple calls)", () => {
      const result1 = buildGraph(testDocs);
      const result2 = buildGraph(testDocs);

      expect(result1.nodes.length).toEqual(result2.nodes.length);
      for (let i = 0; i < result1.nodes.length; i++) {
        const n1 = result1.nodes[i];
        const n2 = result2.nodes[i];
        expect(n1.id).toEqual(n2.id);
        expect(n1.type).toEqual(n2.type);
        expect(n1.label).toEqual(n2.label);
      }

      expect(result1.edges.length).toEqual(result2.edges.length);
      for (let i = 0; i < result1.edges.length; i++) {
        const e1 = result1.edges[i];
        const e2 = result2.edges[i];
        expect(e1.from).toEqual(e2.from);
        expect(e1.to).toEqual(e2.to);
        expect(e1.kind).toEqual(e2.kind);
      }
    });
  });

  describe("toGraphJSON", () => {
    it("produces valid JSON", () => {
      const json = toGraphJSON(testDocs);
      expect(() => JSON.parse(json)).not.toThrow();
    });

    it("includes version 1", () => {
      const json = toGraphJSON(testDocs);
      const parsed = JSON.parse(json);
      expect(parsed.version).toBe(1);
    });

    it("includes nodes and edges", () => {
      const json = toGraphJSON(testDocs);
      const parsed = JSON.parse(json);
      expect(Array.isArray(parsed.nodes)).toBe(true);
      expect(Array.isArray(parsed.edges)).toBe(true);
    });

    it("ends with newline", () => {
      const json = toGraphJSON(testDocs);
      expect(json.endsWith("\n")).toBe(true);
    });

    it("is deterministic", () => {
      const json1 = toGraphJSON(testDocs);
      const json2 = toGraphJSON(testDocs);
      expect(json1).toEqual(json2);
    });
  });

  describe("toMermaid", () => {
    it("starts with flowchart LR", () => {
      const mermaid = toMermaid(testDocs);
      expect(mermaid.split("\n")[0]).toEqual("flowchart LR");
    });

    it("contains node lines for each node", () => {
      const mermaid = toMermaid(testDocs);
      const { nodes } = buildGraph(testDocs);
      const lines = mermaid.trim().split("\n");
      expect(lines.length).toBeGreaterThanOrEqual(nodes.length + 1);
    });

    it("contains edge lines with kind labels", () => {
      const mermaid = toMermaid(testDocs);
      expect(mermaid).toContain("|contains|");
      expect(mermaid).toContain("|documents|");
      expect(mermaid).toContain("|owns|");
      expect(mermaid).toContain("|imports|");
    });

    it("sanitizes node ids (no special chars in raw ids)", () => {
      const mermaid = toMermaid(testDocs);
      // "doc:README.md" → "n_doc_README_md"; colons/dots in labels are fine
      const lines = mermaid.split("\n");
      for (const line of lines) {
        // Skip flowchart declaration and edge definitions (they use sanitized ids on both sides)
        if (
          line === "flowchart LR" ||
          line.includes("-->") ||
          line.trim() === ""
        ) {
          continue;
        }
        const beforeBracket = line.split(/[[(/]/, 1)[0];
        expect(beforeBracket).not.toContain(":");
        expect(beforeBracket).not.toContain(".");
      }
    });

    it("escapes double quotes in labels", () => {
      const mermaid = toMermaid(testDocs);
      expect(mermaid).toContain('\\"');
    });

    it("includes module nodes with folder-like syntax", () => {
      const mermaid = toMermaid(testDocs);
      expect(mermaid).toContain("[/");
    });

    it("is deterministic", () => {
      const mermaid1 = toMermaid(testDocs);
      const mermaid2 = toMermaid(testDocs);
      expect(mermaid1).toEqual(mermaid2);
    });
  });

  describe("toDot", () => {
    it("starts with digraph metonym {", () => {
      const dot = toDot(testDocs);
      expect(dot).toContain("digraph metonym {");
    });

    it("ends with }\\n", () => {
      const dot = toDot(testDocs);
      expect(dot.endsWith("}\n")).toBe(true);
    });

    it("includes rankdir=LR", () => {
      const dot = toDot(testDocs);
      expect(dot).toContain("rankdir=LR;");
    });

    it("has balanced braces", () => {
      const dot = toDot(testDocs);
      const openCount = (dot.match(/{/g) || []).length;
      const closeCount = (dot.match(/}/g) || []).length;
      expect(openCount).toBe(closeCount);
    });

    it("includes node lines with labels and shapes", () => {
      const dot = toDot(testDocs);
      const { nodes } = buildGraph(testDocs);
      for (const _node of nodes) {
        expect(dot).toContain(`[label=`);
        expect(dot).toContain(`shape=`);
      }
    });

    it("has folder shape for module nodes", () => {
      const dot = toDot(testDocs);
      expect(dot).toContain("shape=folder");
    });

    it("has box3d shape for document nodes", () => {
      const dot = toDot(testDocs);
      expect(dot).toContain("shape=box3d");
    });

    it("has ellipse shape for example nodes", () => {
      const dot = toDot(testDocs);
      expect(dot).toContain("shape=ellipse");
    });

    it("has box shape for symbol nodes", () => {
      const dot = toDot(testDocs);
      expect(dot).toContain("shape=box");
    });

    it("includes edge lines with labels", () => {
      const dot = toDot(testDocs);
      expect(dot).toContain("[label=");
      const { edges } = buildGraph(testDocs);
      for (const edge of edges) {
        expect(dot).toContain(`[label="${edge.kind}"]`);
      }
    });

    it("properly quotes and escapes ids and labels", () => {
      const dot = toDot(testDocs);
      const lines = dot.split("\n");
      for (const line of lines) {
        if (line.includes("[label=")) {
          expect(line).toContain('"');
        }
        if (line.includes("->")) {
          expect(line).toContain('"');
        }
      }
    });

    it("every edge references a declared node", () => {
      const dot = toDot(testDocs);
      const { nodes } = buildGraph(testDocs);
      const nodeIds = new Set(nodes.map((n) => n.id));

      const edgePattern = /"([^"]+)"\s*->\s*"([^"]+)"/g;
      let match = edgePattern.exec(dot);
      while (match !== null) {
        const fromId = match[1];
        const toId = match[2];
        expect(nodeIds).toContain(fromId);
        expect(nodeIds).toContain(toId);
        match = edgePattern.exec(dot);
      }
    });

    it("is deterministic", () => {
      const dot1 = toDot(testDocs);
      const dot2 = toDot(testDocs);
      expect(dot1).toEqual(dot2);
    });
  });
});
