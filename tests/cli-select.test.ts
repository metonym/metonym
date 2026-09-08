import { describe, expect, it } from "bun:test";
import type { DocumentationSet } from "../src/ir/types";
import { selectExamples } from "../src/cli/select";

function makeDocs(): DocumentationSet {
  return {
    irVersion: 1,
    tool: { name: "metonym", version: "0.1.0" },
    root: "/tmp/x",
    documents: [
      {
        id: "doc:README.md",
        file: "README.md",
        origin: "readme",
        title: "Doc",
        exampleIds: ["ex:README.md:aaaaaaaa", "ex:README.md:bbbbbbbb"],
      },
    ],
    examples: [
      {
        id: "ex:README.md:aaaaaaaa",
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
        title: "Quick start › example 1",
      },
      {
        id: "ex:README.md:bbbbbbbb",
        documentId: "doc:README.md",
        source: {
          file: "README.md",
          start: { line: 18, column: 1, offset: 150 },
          end: { line: 20, column: 1, offset: 200 },
        },
        fenceSource: {
          file: "README.md",
          start: { line: 17, column: 1, offset: 140 },
          end: { line: 21, column: 1, offset: 210 },
        },
        language: "ts",
        code: "expect(2).toBe(2)",
        kind: "assertion",
        title: "Broken claim › example 1",
      },
    ],
    symbols: [],
    relations: [],
  };
}

describe("selectExamples", () => {
  it("keeps only the example matching a full id", () => {
    const docs = makeDocs();
    selectExamples(docs, { only: ["ex:README.md:aaaaaaaa"] });
    expect(docs.examples.map((e) => e.id)).toEqual(["ex:README.md:aaaaaaaa"]);
    expect(docs.documents[0].exampleIds).toEqual(["ex:README.md:aaaaaaaa"]);
  });

  it("matches on an id prefix", () => {
    const docs = makeDocs();
    selectExamples(docs, { only: ["ex:README.md:bbbb"] });
    expect(docs.examples.map((e) => e.id)).toEqual(["ex:README.md:bbbbbbbb"]);
  });

  it("matches on docFile:startLine", () => {
    const docs = makeDocs();
    selectExamples(docs, { only: ["README.md:5"] });
    expect(docs.examples.map((e) => e.id)).toEqual(["ex:README.md:aaaaaaaa"]);
  });

  it("throws a UsageError when an --only entry matches nothing", () => {
    const docs = makeDocs();
    expect(() => selectExamples(docs, { only: ["ex:README.md:zzzz"] })).toThrow(
      "no example matches --only=ex:README.md:zzzz",
    );
  });

  it("combines --only and --filter as an intersection", () => {
    const docs = makeDocs();
    selectExamples(docs, {
      only: ["ex:README.md:aaaaaaaa", "ex:README.md:bbbbbbbb"],
      filter: "Broken",
    });
    expect(docs.examples.map((e) => e.id)).toEqual(["ex:README.md:bbbbbbbb"]);
  });

  it("filter alone narrows by title substring", () => {
    const docs = makeDocs();
    selectExamples(docs, { filter: "Quick start" });
    expect(docs.examples.map((e) => e.id)).toEqual(["ex:README.md:aaaaaaaa"]);
  });

  it("no options leaves docs unchanged", () => {
    const docs = makeDocs();
    const before = docs.examples.map((e) => e.id);
    selectExamples(docs, {});
    expect(docs.examples.map((e) => e.id)).toEqual(before);
  });
});
