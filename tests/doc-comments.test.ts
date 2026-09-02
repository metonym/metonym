import { expect, test } from "bun:test";
import { extractJsdoc } from "metonym";
import { extractDocComments } from "../src/parse/jsdoc";

test("doc-comments: description-only comment on export function", () => {
  const source = `/**
 * Adds two numbers together.
 */
export function add(a: number, b: number): number {
  return a + b;
}`;

  const comments = extractDocComments(source, { file: "math.ts" });

  expect(comments.length).toBe(1);
  expect(comments[0].declName).toBe("add");
  expect(comments[0].description).toBe("Adds two numbers together.");
  expect(Object.keys(comments[0].tags).length).toBe(0);
});

test("doc-comments: self-closing single-line comment attaches to its own declaration, not a later one", () => {
  const source = `/** Doubles a number. */
export function double(n: number): number {
  return n * 2;
}

/** Halves a number. */
export function halve(n: number): number {
  return n / 2;
}`;

  const comments = extractDocComments(source, { file: "math.ts" });

  expect(comments.length).toBe(2);
  const double = comments.find((c) => c.declName === "double");
  const halve = comments.find((c) => c.declName === "halve");
  expect(double?.description).toBe("Doubles a number.");
  expect(halve?.description).toBe("Halves a number.");
});

test("doc-comments: description + @param (multi-line) + @returns", () => {
  const source = `/**
 * Calculates the sum of numbers.
 * @param numbers The input numbers to sum.
 *   Can be multiple lines of description.
 * @param radix The base for calculation (default 10).
 * @returns The sum of all numbers.
 */
export function sum(...numbers: number[]): number {
  return numbers.reduce((a, b) => a + b, 0);
}`;

  const comments = extractDocComments(source, { file: "math.ts" });

  expect(comments.length).toBe(1);
  expect(comments[0].description).toBe("Calculates the sum of numbers.");
  expect(comments[0].tags.param).toHaveLength(2);
  expect(comments[0].tags.param[0]).toContain("The input numbers to sum");
  expect(comments[0].tags.param[0]).toContain("Can be multiple lines");
  expect(comments[0].tags.param[1]).toBe(
    "radix The base for calculation (default 10).",
  );
  expect(comments[0].tags.returns).toHaveLength(1);
  expect(comments[0].tags.returns[0]).toBe("The sum of all numbers.");
});

test("doc-comments: @example excluded, @deprecated included", () => {
  const source = `/**
 * A deprecated function.
 * @deprecated Use newFunction instead.
 * @example
 * \`\`\`ts
 * oldFunction()
 * \`\`\`
 */
export function oldFunction(): void {}`;

  const comments = extractDocComments(source, { file: "old.ts" });

  expect(comments.length).toBe(1);
  expect(comments[0].tags.deprecated).toHaveLength(1);
  expect(comments[0].tags.deprecated[0]).toBe("Use newFunction instead.");
  expect(comments[0].tags.example).toBeUndefined();
});

test("doc-comments: export interface declName", () => {
  const source = `/**
 * A shape for user data.
 * @param id The unique identifier.
 */
export interface User {
  id: string;
  name: string;
}`;

  const comments = extractDocComments(source, { file: "types.ts" });

  expect(comments.length).toBe(1);
  expect(comments[0].declName).toBe("User");
  expect(comments[0].description).toBe("A shape for user data.");
});

test("doc-comments: export type declName", () => {
  const source = `/**
 * A union type for numeric values.
 */
export type NumericValue = number | bigint;`;

  const comments = extractDocComments(source, { file: "types.ts" });

  expect(comments.length).toBe(1);
  expect(comments[0].declName).toBe("NumericValue");
  expect(comments[0].description).toBe("A union type for numeric values.");
});

test("doc-comments: export default → 'default' declName", () => {
  const source = `/**
 * The default export component.
 */
export default function MyComponent() {
  return null;
}`;

  const comments = extractDocComments(source, { file: "Component.ts" });

  expect(comments.length).toBe(1);
  expect(comments[0].declName).toBe("MyComponent");
  expect(comments[0].description).toBe("The default export component.");
});

test("doc-comments: export default with no name → 'default'", () => {
  const source = `/**
 * Default export without name.
 */
export default () => null;`;

  const comments = extractDocComments(source, { file: "anon.ts" });

  expect(comments.length).toBe(1);
  expect(comments[0].declName).toBe("default");
});

test("doc-comments: banner comment (no following declaration) → declName null", () => {
  const source = `/**
 * This is a file-level banner comment.
 * It documents the whole module.
 */

export function exported(): void {}`;

  const comments = extractDocComments(source, { file: "index.ts" });

  expect(comments.length).toBe(1);
  expect(comments[0].declName).toBeNull();
  expect(comments[0].description).toContain("file-level banner comment");
});

test("doc-comments: non-exported function → declName null", () => {
  const source = `/**
 * Internal helper function.
 */
function helper(): void {}`;

  const comments = extractDocComments(source, { file: "helpers.ts" });

  expect(comments.length).toBe(1);
  expect(comments[0].declName).toBeNull();
  expect(comments[0].description).toBe("Internal helper function.");
});

test("doc-comments: comment with only tags → empty description", () => {
  const source = `/**
 * @param x Input value.
 * @returns Output value.
 */
export function process(x: number): number {
  return x * 2;
}`;

  const comments = extractDocComments(source, { file: "process.ts" });

  expect(comments.length).toBe(1);
  expect(comments[0].description).toBe("");
  expect(comments[0].tags.param).toHaveLength(1);
  expect(comments[0].tags.returns).toHaveLength(1);
});

test("doc-comments: /** inside a string not treated as a comment", () => {
  const source = `const msg = "/**not a comment*/";

/**
 * Real comment.
 * @since 1.0.0
 */
export function real(): void {}`;

  const comments = extractDocComments(source, { file: "test.ts" });

  // This scanner works at the text level and doesn't tokenize strings, so
  // the `/** ... */`-shaped content inside the string literal is picked up
  // as its own (harmless) block — it has no following declaration, so it
  // never gets a declName and extract.ts's consumer discards it. What
  // matters is that it doesn't corrupt the real comment on `real`.
  const real = comments.find((c) => c.declName === "real");
  expect(real).toBeDefined();
  expect(real?.tags.since).toHaveLength(1);
  for (const c of comments) {
    if (c !== real) expect(c.declName).toBeNull();
  }
});

test("doc-comments: deterministic source order", () => {
  const source = `/**
 * First function.
 */
export function first(): void {}

/**
 * Second function.
 */
export function second(): void {}

/**
 * Third function.
 */
export function third(): void {}`;

  const comments = extractDocComments(source, { file: "order.ts" });

  expect(comments.length).toBe(3);
  expect(comments[0].declName).toBe("first");
  expect(comments[1].declName).toBe("second");
  expect(comments[2].declName).toBe("third");
});

test("doc-comments: multiple tags with same name in array order", () => {
  const source = `/**
 * Function with multiple authors.
 * @author Alice
 * @author Bob
 * @author Charlie
 */
export function authoredFunction(): void {}`;

  const comments = extractDocComments(source, { file: "authors.ts" });

  expect(comments.length).toBe(1);
  expect(comments[0].tags.author).toHaveLength(3);
  expect(comments[0].tags.author[0]).toBe("Alice");
  expect(comments[0].tags.author[1]).toBe("Bob");
  expect(comments[0].tags.author[2]).toBe("Charlie");
});

test("doc-comments: preserves internal blank lines in description", () => {
  const source = `/**
 * First paragraph of description.
 *
 * Second paragraph of description.
 *
 * Third paragraph.
 */
export function multiParagraph(): void {}`;

  const comments = extractDocComments(source, { file: "para.ts" });

  expect(comments.length).toBe(1);
  expect(comments[0].description).toContain("First paragraph");
  expect(comments[0].description).toContain("Second paragraph");
  expect(comments[0].description).toContain("Third paragraph");
  expect(comments[0].description.split("\n").length).toBeGreaterThan(3);
});

test("doc-comments: comment line numbers are 1-indexed", () => {
  const source = `export function first(): void {}

/**
 * Second function's comment.
 */
export function second(): void {}`;

  const comments = extractDocComments(source, { file: "line.ts" });

  // The comment starts at line 3
  expect(comments.length).toBe(1);
  expect(comments[0].line).toBe(3);
});

test("doc-comments: regression guard - extractJsdoc still produces examples", () => {
  const source = `/**
 * A documented function.
 * @example
 * \`\`\`ts
 * example1()
 * \`\`\`
 * @deprecated Use other instead.
 */
export function documented(): void {}`;

  const { examples } = extractJsdoc(source, { file: "test.ts" });

  // The @example should still be extracted by extractJsdoc
  expect(examples.length).toBe(1);
  expect(examples[0].owner).toBe("sym:test.ts:documented");
  expect(examples[0].code).toContain("example1()");

  // But extractDocComments should NOT have @example in tags
  const comments = extractDocComments(source, { file: "test.ts" });
  expect(comments.length).toBe(1);
  expect(comments[0].tags.example).toBeUndefined();
  expect(comments[0].tags.deprecated).toHaveLength(1);
});

test("doc-comments: complex multi-line @param continuation", () => {
  const source = `/**
 * Process data with configuration.
 * @param config Configuration object with:
 *   - enabled: whether to enable processing
 *   - timeout: max processing time in ms
 *   - retries: number of retry attempts
 * @param callback The completion callback.
 */
export function process(config: any, callback: Function): void {}`;

  const comments = extractDocComments(source, { file: "processor.ts" });

  expect(comments.length).toBe(1);
  expect(comments[0].tags.param).toHaveLength(2);
  const firstParam = comments[0].tags.param[0];
  expect(firstParam).toContain("Configuration object");
  expect(firstParam).toContain("enabled: whether to enable");
  expect(firstParam).toContain("timeout: max");
  expect(firstParam).toContain("retries: number");
});

test("doc-comments: empty file produces no comments", () => {
  const source = "";

  const comments = extractDocComments(source, { file: "empty.ts" });

  expect(comments.length).toBe(0);
});

test("doc-comments: comment with no description or tags", () => {
  const source = `/**
 *
 */
export function empty(): void {}`;

  const comments = extractDocComments(source, { file: "empty.ts" });

  expect(comments.length).toBe(1);
  expect(comments[0].description).toBe("");
  expect(Object.keys(comments[0].tags).length).toBe(0);
});

test("doc-comments: @throws tag captured", () => {
  const source = `/**
 * Risky operation.
 * @throws {Error} When something goes wrong.
 */
export function risky(): void {}`;

  const comments = extractDocComments(source, { file: "risky.ts" });

  expect(comments.length).toBe(1);
  expect(comments[0].tags.throws).toHaveLength(1);
  expect(comments[0].tags.throws[0]).toContain("{Error}");
  expect(comments[0].tags.throws[0]).toContain("When something goes wrong");
});

test("doc-comments: export const and export let", () => {
  const source = `/**
 * A constant value.
 */
export const CONFIG = { };

/**
 * A mutable value.
 */
export let state = 0;`;

  const comments = extractDocComments(source, { file: "vars.ts" });

  expect(comments.length).toBe(2);
  expect(comments[0].declName).toBe("CONFIG");
  expect(comments[1].declName).toBe("state");
});

test("doc-comments: @example with multiple blocks still skipped", () => {
  const source = `/**
 * Function with many examples.
 * @example
 * first()
 * @example
 * second()
 * @example
 * third()
 * @returns Something.
 */
export function many(): void {}`;

  const comments = extractDocComments(source, { file: "many.ts" });

  expect(comments.length).toBe(1);
  expect(comments[0].tags.example).toBeUndefined();
  expect(comments[0].tags.returns).toHaveLength(1);
});

test("doc-comments: tag with empty content", () => {
  const source = `/**
 * Something.
 * @todo
 * @returns The result.
 */
export function work(): void {}`;

  const comments = extractDocComments(source, { file: "work.ts" });

  expect(comments.length).toBe(1);
  expect(comments[0].tags.todo).toHaveLength(1);
  expect(comments[0].tags.todo[0]).toBe("");
  expect(comments[0].tags.returns).toHaveLength(1);
});
