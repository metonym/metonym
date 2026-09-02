import { expect, test } from "bun:test";
import { extractJsdoc } from "metonym";

test("jsdoc: @example fence under export function", () => {
  const source = `/**
 * Adds two numbers.
 * @example
 * \`\`\`ts
 * expect(add(2, 3)).toBe(5)
 * \`\`\`
 */
export function add(a: number, b: number): number {
  return a + b;
}`;

  const { document, examples } = extractJsdoc(source, { file: "math.ts" });

  expect(document).not.toBeNull();
  expect(examples.length).toBe(1);
  expect(examples[0].owner).toBe("sym:math.ts:add");
  expect(examples[0].code).toContain("expect(add(2, 3))");
  expect(examples[0].kind).toBe("assertion");
});

test("jsdoc: correct real file line for body", () => {
  const source = `/**
 * Test function.
 * @example
 * \`\`\`ts
 * code()
 * \`\`\`
 */
export function test(): void {}`;

  const { examples } = extractJsdoc(source, { file: "test.ts" });

  expect(examples.length).toBe(1);
  // The code starts at line 5 (1-indexed)
  expect(examples[0].source.start.line).toBe(5);
});

test("jsdoc: two examples in one comment numbered 1 and 2", () => {
  const source = `/**
 * Function with multiple examples.
 * @example
 * \`\`\`ts
 * example1()
 * \`\`\`
 * @example
 * \`\`\`ts
 * example2()
 * \`\`\`
 */
export function multiExample(): void {}`;

  const { examples } = extractJsdoc(source, { file: "test.ts" });

  expect(examples.length).toBe(2);
  expect(examples[0].title).toContain("example 1");
  expect(examples[1].title).toContain("example 2");
});

test("jsdoc: fenceless @example content treated as ts assertion", () => {
  const source = `/**
 * Test function.
 * @example
 * expect(true).toBe(true)
 */
export function test(): void {}`;

  const { examples } = extractJsdoc(source, { file: "test.ts" });

  expect(examples.length).toBe(1);
  expect(examples[0].language).toBe("ts");
  expect(examples[0].kind).toBe("assertion");
  expect(examples[0].code).toContain("expect(true)");
});

test("jsdoc: @example with multiple lines of code", () => {
  const source = `/**
 * Test function.
 * @example
 * const x = 1
 * const y = 2
 * expect(x + y).toBe(3)
 */
export function test(): void {}`;

  const { examples } = extractJsdoc(source, { file: "test.ts" });

  expect(examples.length).toBe(1);
  expect(examples[0].code).toContain("const x = 1");
  expect(examples[0].code).toContain("const y = 2");
  expect(examples[0].code).toContain("expect(x + y)");
});

test("jsdoc: /** inside a string literal ignored", () => {
  const source = `const msg = "/**not a comment*/";

/**
 * Real comment.
 * @example
 * test()
 */
export function test(): void {}`;

  const { examples } = extractJsdoc(source, { file: "test.ts" });

  expect(examples.length).toBe(1);
});

test("jsdoc: comment with no @example produces no examples", () => {
  const source = `/**
 * Just a regular comment.
 * No examples here.
 */
export function test(): void {}`;

  const { examples, document } = extractJsdoc(source, { file: "test.ts" });

  expect(examples.length).toBe(0);
  expect(document).toBeNull();
});

test("jsdoc: document null when no examples", () => {
  const source = `/**
 * Function without examples.
 */
function test(): void {}`;

  const { document } = extractJsdoc(source, { file: "test.ts" });

  expect(document).toBeNull();
});

test("jsdoc: document not null when examples exist", () => {
  const source = `/**
 * Function with example.
 * @example
 * test()
 */
export function test(): void {}`;

  const { document } = extractJsdoc(source, { file: "test.ts" });

  expect(document).not.toBeNull();
  expect(document?.origin).toBe("jsdoc");
});

test("jsdoc: owner set only for exported declarations", () => {
  const sourceExported = `/**
 * Exported function.
 * @example
 * test()
 */
export function test(): void {}`;

  const { examples: examplesExported } = extractJsdoc(sourceExported, {
    file: "test.ts",
  });
  expect(examplesExported[0].owner).toBe("sym:test.ts:test");

  const sourceNotExported = `/**
 * Non-exported function.
 * @example
 * test()
 */
function test(): void {}`;

  const { examples: examplesNotExported } = extractJsdoc(sourceNotExported, {
    file: "test.ts",
  });
  expect(examplesNotExported[0].owner).toBeUndefined();
});

test("jsdoc: fence kinds are captured", () => {
  const source = `/**
 * Test.
 * @example
 * \`\`\`ts no-run
 * no_run()
 * \`\`\`
 * @example
 * \`\`\`ts throws
 * throws_fn()
 * \`\`\`
 * @example
 * \`\`\`ts pending
 * pending_fn()
 * \`\`\`
 */
export function test(): void {}`;

  const { examples } = extractJsdoc(source, { file: "test.ts" });

  expect(examples.length).toBe(3);
  expect(examples[0].kind).toBe("no-run");
  expect(examples[1].kind).toBe("throws");
  expect(examples[2].kind).toBe("pending");
});

test("jsdoc: ignore blocks excluded", () => {
  const source = `/**
 * Test.
 * @example
 * \`\`\`ts ignore
 * ignored()
 * \`\`\`
 * @example
 * \`\`\`ts
 * executed()
 * \`\`\`
 */
export function test(): void {}`;

  const { examples } = extractJsdoc(source, { file: "test.ts" });

  expect(examples.length).toBe(1);
  expect(examples[0].code).toContain("executed()");
});

test("jsdoc: multiple comments each with examples", () => {
  const source = `/**
 * First function.
 * @example
 * first()
 */
export function first(): void {}

/**
 * Second function.
 * @example
 * second()
 */
export function second(): void {}`;

  const { examples } = extractJsdoc(source, { file: "test.ts" });

  expect(examples.length).toBe(2);
  expect(examples[0].owner).toBe("sym:test.ts:first");
  expect(examples[1].owner).toBe("sym:test.ts:second");
});

test("jsdoc: strip comment prefixes correctly", () => {
  const source = `/**
 * Test.
 * @example
 * \`\`\`ts
 * code()
 * \`\`\`
 */
export function test(): void {}`;

  const { examples } = extractJsdoc(source, { file: "test.ts" });

  expect(examples.length).toBe(1);
  expect(examples[0].code).toContain("code()");
});

test("jsdoc: declaration after comment can be default export", () => {
  const source = `/**
 * Default export.
 * @example
 * test()
 */
export default function() {}`;

  const { examples } = extractJsdoc(source, { file: "test.ts" });

  expect(examples.length).toBe(1);
});

test("jsdoc: example with group attribute", () => {
  const source = `/**
 * Test.
 * @example
 * \`\`\`ts group=setup
 * setup()
 * \`\`\`
 */
export function test(): void {}`;

  const { examples } = extractJsdoc(source, { file: "test.ts" });

  expect(examples.length).toBe(1);
  expect(examples[0].group).toBe("setup");
});

test("jsdoc: non-executable language excluded", () => {
  const source = `/**
 * Test.
 * @example
 * \`\`\`json
 * {"key": "value"}
 * \`\`\`
 * @example
 * \`\`\`ts
 * real_code()
 * \`\`\`
 */
export function test(): void {}`;

  const { examples } = extractJsdoc(source, { file: "test.ts" });

  expect(examples.length).toBe(1);
  expect(examples[0].code).toContain("real_code()");
});

test("jsdoc: all examples in one document", () => {
  const source = `/**
 * Doc.
 * @example
 * test1()
 * @example
 * test2()
 */
export function test(): void {}`;

  const { document, examples } = extractJsdoc(source, { file: "test.ts" });

  expect(document).not.toBeNull();
  expect(document?.exampleIds.length).toBe(2);
  expect(examples.length).toBe(2);
});

test("jsdoc: source location includes fence delimiters", () => {
  const source = `/**
 * Test.
 * @example
 * \`\`\`ts
 * code()
 * \`\`\`
 */
export function test(): void {}`;

  const { examples } = extractJsdoc(source, { file: "test.ts" });

  expect(examples.length).toBe(1);
  expect(examples[0].fenceSource).toBeDefined();
});

test("jsdoc: async function recognized", () => {
  const source = `/**
 * Async function.
 * @example
 * await test()
 */
export async function test(): Promise<void> {}`;

  const { examples } = extractJsdoc(source, { file: "test.ts" });

  expect(examples.length).toBe(1);
  expect(examples[0].owner).toBe("sym:test.ts:test");
});

test("jsdoc: class declaration recognized", () => {
  const source = `/**
 * Test class.
 * @example
 * new Test()
 */
export class Test {}`;

  const { examples } = extractJsdoc(source, { file: "test.ts" });

  expect(examples.length).toBe(1);
  expect(examples[0].owner).toBe("sym:test.ts:Test");
});

test("jsdoc: empty @example section ignored if no content", () => {
  const source = `/**
 * Test.
 * @example
 * @other
 */
export function test(): void {}`;

  const { examples } = extractJsdoc(source, { file: "test.ts" });

  expect(examples.length).toBe(0);
});

test("jsdoc: @example followed by other tags", () => {
  const source = `/**
 * Test.
 * @example
 * test()
 * @param x The param
 */
export function test(x: number): void {}`;

  const { examples } = extractJsdoc(source, { file: "test.ts" });

  expect(examples.length).toBe(1);
  expect(examples[0].code).toContain("test()");
});
