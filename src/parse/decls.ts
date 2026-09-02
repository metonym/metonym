/**
 * Export declaration scanner — identifies all export kinds and positions.
 * Light state machine skips strings, template literals, and comments.
 * Regex literals are a non-goal.
 */

import type { DeclKind } from "../ir/types";
import { isWhitespaceCode } from "./chars";

export interface Decl {
  name: string;
  declKind: DeclKind;
  line: number; // 1-indexed
  column: number; // 1-indexed at NAME (or export keyword for lists)
  offset: number; // 0-indexed byte offset at NAME
  reexportFrom?: string;
}

// Scanner states. Numeric so transitions don't allocate.
const CODE = 0;
const LINE_COMMENT = 1;
const BLOCK_COMMENT = 2;
const STRING = 3;
const TEMPLATE = 4;

const CH_NEWLINE = 10;
const CH_TAB = 9;
const CH_SPACE = 32;
const CH_QUOTE = 34;
const CH_APOS = 39;
const CH_STAR = 42;
const CH_SLASH = 47;
const CH_BACKSLASH = 92;
const CH_BACKTICK = 96;
const CH_LBRACE = 123;
const CH_RBRACE = 125;
const CH_LBRACK = 91;
const CH_RBRACK = 93;
const CH_SEMI = 59;
const CH_e = 101;

/**
 * Line-start offsets (0-indexed). indexOf-driven, so it never touches
 * non-newline characters individually.
 */
function buildLineStarts(source: string): number[] {
  const starts = [0];
  let i = source.indexOf("\n");
  while (i !== -1) {
    starts.push(i + 1);
    i = source.indexOf("\n", i + 1);
  }
  return starts;
}

function lineColumnAt(
  starts: number[],
  offset: number,
): { line: number; column: number } {
  let lo = 0;
  let hi = starts.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (starts[mid] <= offset) lo = mid;
    else hi = mid - 1;
  }
  return { line: lo + 1, column: offset - starts[lo] + 1 };
}

/**
 * Extract names from a destructuring pattern like { a, b: c } or [a, b].
 * Returns the binding names (right-hand side of any rename).
 */
function extractDestructuredNames(pattern: string): string[] {
  const names: string[] = [];
  let current = "";

  for (let i = 0; i < pattern.length; i++) {
    const ch = pattern[i];

    if (ch === "," || i === pattern.length - 1) {
      if (i === pattern.length - 1 && ch !== ",") {
        current += ch;
      }
      current = current.trim();
      if (current) {
        // Parse "a" or "a: b" → extract 'b' if renamed, else 'a'
        const parts = current.split(":").map((s) => s.trim());
        const name = parts[1] || parts[0];
        if (name && /^[A-Za-z_$][\w$]*$/.test(name)) {
          names.push(name);
        }
      }
      current = "";
    } else {
      current += ch;
    }
  }

  return names;
}

/**
 * Scan source code and return all export declarations.
 */
export function scanDecls(source: string): Decl[] {
  const decls: Decl[] = [];
  if (!source.includes("export")) return decls;

  const lineStarts = buildLineStarts(source);
  const n = source.length;
  let state = CODE;
  let quote = 0;
  let i = 0;

  while (i < n) {
    const ch = source.charCodeAt(i);

    if (state === LINE_COMMENT) {
      const nl = source.indexOf("\n", i);
      if (nl === -1) break;
      state = CODE;
      i = nl + 1;
      continue;
    }

    if (state === BLOCK_COMMENT) {
      const close = source.indexOf("*/", i);
      if (close === -1) break;
      state = CODE;
      i = close + 2;
      continue;
    }

    if (state === STRING) {
      if (ch === CH_BACKSLASH && i + 1 < n) {
        i += 2;
        continue;
      }
      if (ch === quote) state = CODE;
      i++;
      continue;
    }

    if (state === TEMPLATE) {
      if (ch === CH_BACKSLASH && i + 1 < n) {
        i += 2;
        continue;
      }
      if (ch === CH_BACKTICK) state = CODE;
      i++;
      continue;
    }

    if (ch === CH_SLASH && i + 1 < n) {
      const next = source.charCodeAt(i + 1);
      if (next === CH_SLASH) {
        state = LINE_COMMENT;
        i += 2;
        continue;
      }
      if (next === CH_STAR) {
        state = BLOCK_COMMENT;
        i += 2;
        continue;
      }
    }

    if (ch === CH_QUOTE || ch === CH_APOS) {
      state = STRING;
      quote = ch;
      i++;
      continue;
    }

    if (ch === CH_BACKTICK) {
      state = TEMPLATE;
      i++;
      continue;
    }

    if (ch === CH_e && source.startsWith("export", i)) {
      const nextChar = source.charCodeAt(i + 6);
      if (
        nextChar === CH_SPACE ||
        nextChar === CH_TAB ||
        nextChar === CH_NEWLINE
      ) {
        i += 6;

        while (i < n && isWhitespaceCode(source.charCodeAt(i))) {
          i++;
        }

        const exprStart = i;
        let braceDepth = 0;
        let brackDepth = 0;
        let inString = false;
        let stringChar = 0;
        let inTemplate = false;

        while (i < n) {
          const c = source.charCodeAt(i);

          if (inTemplate) {
            if (
              c === CH_BACKTICK &&
              source.charCodeAt(i - 1) !== CH_BACKSLASH
            ) {
              inTemplate = false;
            }
            i++;
            continue;
          }

          if (inString) {
            if (c === stringChar && source.charCodeAt(i - 1) !== CH_BACKSLASH) {
              inString = false;
            }
            i++;
            continue;
          }

          // Without this, a stray apostrophe/quote inside a `//` or `/* */`
          // comment in the statement's body (e.g. a field doc comment)
          // desyncs `inString` and swallows every export up to the next
          // coincidental matching quote in the file.
          if (c === CH_SLASH && i + 1 < n) {
            const next = source.charCodeAt(i + 1);
            if (next === CH_SLASH) {
              const nl = source.indexOf("\n", i);
              i = nl === -1 ? n : nl;
              continue;
            }
            if (next === CH_STAR) {
              const close = source.indexOf("*/", i);
              i = close === -1 ? n : close + 2;
              continue;
            }
          }

          if (c === CH_BACKTICK) {
            inTemplate = true;
            i++;
            continue;
          }

          if (c === CH_QUOTE || c === CH_APOS) {
            inString = true;
            stringChar = c;
            i++;
            continue;
          }

          if (c === CH_LBRACE) {
            braceDepth++;
          } else if (c === CH_RBRACE) {
            braceDepth--;
          } else if (c === CH_LBRACK) {
            brackDepth++;
          } else if (c === CH_RBRACK) {
            brackDepth--;
          } else if (
            (c === CH_SEMI || c === CH_NEWLINE) &&
            braceDepth === 0 &&
            brackDepth === 0
          ) {
            break;
          }

          i++;
        }

        const expr = source.slice(exprStart, i).trim();
        const parsed = parseExportExpr(expr, exprStart, lineStarts);
        for (const d of parsed) decls.push(d);
        continue;
      }
    }

    i++;
  }

  return decls;
}

/**
 * Parse an export expression and return matching declarations.
 * exprStartOffset is the position in source where the export expression starts (after "export " keyword).
 */
function parseExportExpr(
  expr: string,
  exprStartOffset: number,
  lineStarts: number[],
): Decl[] {
  const decls: Decl[] = [];

  if (!expr) {
    return decls;
  }

  // export default ...
  if (expr.startsWith("default ")) {
    const offset = exprStartOffset - 8; // -"export ".length
    const { line, column } = lineColumnAt(lineStarts, offset);
    decls.push({
      name: "default",
      declKind: "default",
      line,
      column,
      offset,
    });
    return decls;
  }

  // export * from "..."
  const starMatch = expr.match(/^\*\s+from\s+["']([^"']+)["']/);
  if (starMatch) {
    const offset = exprStartOffset - 8; // -"export ".length
    const { line, column } = lineColumnAt(lineStarts, offset);
    decls.push({
      name: "*",
      declKind: "reexport",
      line,
      column,
      offset,
      reexportFrom: starMatch[1],
    });
    return decls;
  }

  // export type NAME = ...
  const typeAliasMatch = expr.match(/^type\s+([A-Za-z_$][\w$]*)\s*=/);
  if (typeAliasMatch) {
    const name = typeAliasMatch[1];
    const namePos = expr.indexOf(name);
    const nameOffset = exprStartOffset + namePos;
    const { line, column } = lineColumnAt(lineStarts, nameOffset);
    decls.push({
      name,
      declKind: "type",
      line,
      column,
      offset: nameOffset,
    });
    return decls;
  }

  // export type { ... } or export type { ... } from "..."
  if (expr.startsWith("type ")) {
    const rest = expr.slice(5).trim();
    if (rest.startsWith("{")) {
      return parseNamedExports(rest, exprStartOffset + 5, lineStarts, true);
    }
  }

  // export { ... } or export { ... } from "..."
  if (expr.startsWith("{")) {
    return parseNamedExports(expr, exprStartOffset, lineStarts, false);
  }

  // export (async )?function[*]? NAME
  const funcMatch = expr.match(
    /^(?:async\s+)?function\*?\s+([A-Za-z_$][\w$]*)/,
  );
  if (funcMatch) {
    const name = funcMatch[1];
    const namePos = expr.indexOf(name);
    const nameOffset = exprStartOffset + namePos;
    const { line, column } = lineColumnAt(lineStarts, nameOffset);
    decls.push({
      name,
      declKind: "function",
      line,
      column,
      offset: nameOffset,
    });
    return decls;
  }

  // export (abstract )?class NAME
  const classMatch = expr.match(/^(?:abstract\s+)?class\s+([A-Za-z_$][\w$]*)/);
  if (classMatch) {
    const name = classMatch[1];
    const namePos = expr.indexOf(name);
    const nameOffset = exprStartOffset + namePos;
    const { line, column } = lineColumnAt(lineStarts, nameOffset);
    decls.push({
      name,
      declKind: "class",
      line,
      column,
      offset: nameOffset,
    });
    return decls;
  }

  // export const enum NAME
  const constEnumMatch = expr.match(/^const\s+enum\s+([A-Za-z_$][\w$]*)/);
  if (constEnumMatch) {
    const name = constEnumMatch[1];
    const namePos = expr.indexOf(name);
    const nameOffset = exprStartOffset + namePos;
    const { line, column } = lineColumnAt(lineStarts, nameOffset);
    decls.push({
      name,
      declKind: "enum",
      line,
      column,
      offset: nameOffset,
    });
    return decls;
  }

  // export enum NAME
  const enumMatch = expr.match(/^enum\s+([A-Za-z_$][\w$]*)/);
  if (enumMatch) {
    const name = enumMatch[1];
    const namePos = expr.indexOf(name);
    const nameOffset = exprStartOffset + namePos;
    const { line, column } = lineColumnAt(lineStarts, nameOffset);
    decls.push({
      name,
      declKind: "enum",
      line,
      column,
      offset: nameOffset,
    });
    return decls;
  }

  // export interface NAME
  const interfaceMatch = expr.match(/^interface\s+([A-Za-z_$][\w$]*)/);
  if (interfaceMatch) {
    const name = interfaceMatch[1];
    const namePos = expr.indexOf(name);
    const nameOffset = exprStartOffset + namePos;
    const { line, column } = lineColumnAt(lineStarts, nameOffset);
    decls.push({
      name,
      declKind: "interface",
      line,
      column,
      offset: nameOffset,
    });
    return decls;
  }

  // export const|let|var
  const varMatch = expr.match(/^(const|let|var)\s+/);
  if (varMatch) {
    const keyword = varMatch[1];
    if (keyword !== "const" && keyword !== "let" && keyword !== "var") {
      return decls;
    }
    const afterKeyword = expr.slice(varMatch[0].length);

    if (afterKeyword.startsWith("{") || afterKeyword.startsWith("[")) {
      const closeChar = afterKeyword[0] === "{" ? "}" : "]";
      const closeIdx = afterKeyword.indexOf(closeChar);
      if (closeIdx !== -1) {
        const pattern = afterKeyword.slice(1, closeIdx);
        const names = extractDestructuredNames(pattern);

        for (const name of names) {
          const namePos = afterKeyword.indexOf(name);
          if (namePos !== -1) {
            const nameOffset =
              exprStartOffset + varMatch[0].length + 1 + namePos;
            const { line, column } = lineColumnAt(lineStarts, nameOffset);
            decls.push({
              name,
              declKind: keyword,
              line,
              column,
              offset: nameOffset,
            });
          }
        }
        return decls;
      }
    }

    const simpleMatch = afterKeyword.match(/^([A-Za-z_$][\w$]*)/);
    if (simpleMatch) {
      const name = simpleMatch[1];
      const namePos = afterKeyword.indexOf(name);
      const nameOffset = exprStartOffset + varMatch[0].length + namePos;
      const { line, column } = lineColumnAt(lineStarts, nameOffset);
      decls.push({
        name,
        declKind: keyword,
        line,
        column,
        offset: nameOffset,
      });
      return decls;
    }
  }

  return decls;
}

/**
 * Parse export { a, b as c } or export { a, b as c } from "module".
 * exprStartOffset points to the start of the { in the expression.
 */
function parseNamedExports(
  expr: string,
  exprStartOffset: number,
  lineStarts: number[],
  isType: boolean,
): Decl[] {
  const decls: Decl[] = [];

  const openBrace = expr.indexOf("{");
  const closeBrace = expr.lastIndexOf("}");

  if (openBrace === -1 || closeBrace === -1) {
    return decls;
  }

  const names = expr.slice(openBrace + 1, closeBrace).trim();
  const afterBrace = expr.slice(closeBrace + 1).trim();

  let reexportFrom: string | undefined;
  const fromMatch = afterBrace.match(/^from\s+["']([^"']+)["']/);
  if (fromMatch) {
    reexportFrom = fromMatch[1];
  }

  const parts = names.split(",");
  for (const part of parts) {
    const trimmed = part.trim();
    if (!trimmed) continue;

    // Handle "a as b" → export b
    const asMatch = trimmed.match(
      /^([A-Za-z_$][\w$]*)\s+as\s+([A-Za-z_$][\w$]*)/,
    );
    const exportName = asMatch ? asMatch[2] : trimmed;

    const namePos = names.indexOf(exportName);
    if (namePos !== -1) {
      const nameOffset = exprStartOffset + openBrace + 1 + namePos;
      const { line, column } = lineColumnAt(lineStarts, nameOffset);
      let declKind: DeclKind = "unknown";
      if (isType && reexportFrom) {
        declKind = "reexport";
      } else if (isType) {
        declKind = "type";
      } else if (reexportFrom) {
        declKind = "reexport";
      }

      decls.push({
        name: exportName,
        declKind,
        line,
        column,
        offset: nameOffset,
        reexportFrom,
      });
    }
  }

  return decls;
}
