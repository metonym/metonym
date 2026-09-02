/**
 * Stable, deterministic IDs.
 *
 * example id = "ex:" + file + ":" + hash8(normalize(code)) [+ "~" + n]
 * Editing example A never changes example B's id; moving an example within a
 * file preserves its id; identical bodies in one file are disambiguated by
 * document order (~1, ~2, …). No UUIDs anywhere.
 */

function normalizeCode(code: string): string {
  // Trailing whitespace per line (same as split/replace(/\s+$/)/join, one pass).
  return code.replace(/[^\S\n]+$/gm, "");
}

function hash8(input: string): string {
  return Bun.hash.xxHash64(input).toString(16).padStart(16, "0").slice(0, 8);
}

export function documentId(file: string): string {
  return `doc:${file}`;
}

export function symbolId(file: string, exportName: string): string {
  return `sym:${file}:${exportName}`;
}

/**
 * Allocates ids within one file. Create one allocator per extracted document
 * and call it for each example in document order.
 *
 * @example
 * ```ts
 * import { createExampleIdAllocator } from "metonym"
 *
 * const alloc = createExampleIdAllocator("README.md")
 * const first = alloc("expect(1).toBe(1)")
 * const second = alloc("expect(1).toBe(1)")
 * expect(second).toBe(`${first}~1`)
 * ```
 */
export function createExampleIdAllocator(
  file: string,
): (code: string) => string {
  const seen = new Map<string, number>();
  return (code) => {
    const h = hash8(normalizeCode(code));
    const n = seen.get(h) ?? 0;
    seen.set(h, n + 1);
    return n === 0 ? `ex:${file}:${h}` : `ex:${file}:${h}~${n}`;
  };
}
