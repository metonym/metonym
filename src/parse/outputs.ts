/**
 * `// => value` expected-output comment parsing, shared by the emitter's
 * inline-assertion rewrite (src/emit/generate.ts) and the extracted IR's
 * `Example.outputs` (src/parse/markdown.ts, src/parse/jsdoc.ts).
 */

import { getTranspiler } from "./transpiler.ts";

const OUTPUT_COMMENT_RE = /^(\s*)(.+?)\s*;?\s*\/\/\s*=>\s*(.+?)\s*$/;
const CONTINUATION_RE = /^\s*\/\/\s*=>\s*(.+?)\s*$/;
const EXCLUDED_LEAD_RE =
  /^(?:const|let|var|if|for|while|return|throw|import|export)\b|^\}/;

/** A JSON/JS-literal-safe form: `undefined`, `NaN`, `-Infinity`, a
 * single-quoted string, or a `[...]`/`{...}` structure with unquoted keys. */
const SAFE_LITERAL_RE =
  /^(?:undefined|NaN|-?Infinity|'(?:[^'\\]|\\.)*'|\[[\s\S]*\]|\{[\s\S]*\})$/;

export interface OutputMatch {
  indent: string;
  expr: string;
  value: string;
}

/**
 * Matches `expr // => value` on a single line. Returns null for
 * declaration/keyword/`}`-leading lines (those aren't rewritable
 * expressions) and for comment-only lines (see `matchOutputContinuation`).
 */
export function matchOutputComment(line: string): OutputMatch | null {
  const match = line.match(OUTPUT_COMMENT_RE);
  if (!match) return null;
  const [, indent, exprRaw, value] = match;
  const expr = exprRaw.trim();
  if (expr === "" || EXCLUDED_LEAD_RE.test(expr)) return null;
  return { indent, expr, value };
}

/**
 * Matches a comment-only continuation line (`// => value`, no expression),
 * which extends the previous line's expected value across multiple lines.
 */
export function matchOutputContinuation(line: string): string | null {
  if (matchOutputComment(line)) return null;
  const match = line.match(CONTINUATION_RE);
  return match ? match[1] : null;
}

/**
 * Renders an `expect(...)` assertion for a matched `// => value`, on one
 * line so the doc/generated line invariant holds.
 * - `value` parses as JSON → `expect(expr).toEqual(value)`
 * - `value` is a safe-to-inline JS literal (checked via a transpile) →
 *   `expect(expr).toEqual(value)`
 * - otherwise → `expect(String(expr)).toBe(JSON.stringify(value))`
 */
export function buildOutputAssertion(
  indent: string,
  expr: string,
  value: string,
): string {
  const literal = inlineableLiteral(value);
  if (literal !== undefined) {
    return `${indent}expect(${expr}).toEqual(${literal});`;
  }
  return `${indent}expect(String(${expr})).toBe(${JSON.stringify(value)});`;
}

function inlineableLiteral(value: string): string | undefined {
  try {
    JSON.parse(value);
    return value;
  } catch {
    // not JSON — fall through to the JS-literal check
  }
  if (!SAFE_LITERAL_RE.test(value)) return undefined;
  try {
    getTranspiler("js").transformSync(`(${value})`);
    return value;
  } catch {
    return undefined;
  }
}

/**
 * Rewrites `expr // => value` lines into `expect(...)` assertions, in
 * place, preserving line count: continuation lines become
 * `// metonym: expected continued`.
 */
export function transformOutputComments(lines: string[]): string[] {
  const result: string[] = [];
  let i = 0;
  while (i < lines.length) {
    const match = matchOutputComment(lines[i]);
    if (!match) {
      result.push(lines[i]);
      i++;
      continue;
    }

    const values = [match.value];
    let consumed = 1;
    while (i + consumed < lines.length) {
      const cont = matchOutputContinuation(lines[i + consumed]);
      if (cont === null) break;
      values.push(cont);
      consumed++;
    }

    result.push(
      buildOutputAssertion(match.indent, match.expr, values.join(" ")),
    );
    for (let k = 1; k < consumed; k++) {
      result.push("// metonym: expected continued");
    }
    i += consumed;
  }
  return result;
}

export interface OutputComment {
  /** 1-based line within the example's `code`. */
  line: number;
  expected: string;
}

/**
 * Scans an example's code for `// => value` comments (joining multi-line
 * continuations), without rewriting anything. Used to populate
 * `Example.outputs` at extract time so renderers and `check --update`
 * don't need to re-run this scan themselves.
 */
export function scanOutputComments(code: string): OutputComment[] {
  const lines = code.split("\n");
  const outputs: OutputComment[] = [];
  let i = 0;
  while (i < lines.length) {
    const match = matchOutputComment(lines[i]);
    if (!match) {
      i++;
      continue;
    }
    const startLine = i + 1;
    const values = [match.value];
    i++;
    while (i < lines.length) {
      const cont = matchOutputContinuation(lines[i]);
      if (cont === null) break;
      values.push(cont);
      i++;
    }
    outputs.push({ line: startLine, expected: values.join(" ") });
  }
  return outputs;
}
