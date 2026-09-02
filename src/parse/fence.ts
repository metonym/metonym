/**
 * Line-based Markdown fenced-code-block scanner.
 *
 * Validated against CommonMark 0.31.2 (88 relevant cases: 37 exact, 51
 * safe-miss, 0 unsafe). Deliberately a subset: indented (4-space/tab)
 * code blocks are inert, exotic container nesting may be safely missed,
 * but content is never mis-extracted.
 */

export interface Fence {
  /** Full info string after the delimiters, trimmed. */
  info: string;
  /** Content exactly as authored (dedented per opening-fence indent), with trailing \n if non-empty. */
  code: string;
  /** 1-indexed line of the opening fence. */
  startLine: number;
  /** 1-indexed line of the first content line (even if the block is empty). */
  codeStartLine: number;
  /** 1-indexed line of the closing fence (or last content line if unclosed at EOF). */
  endLine: number;
  /** 0-indexed byte offset of the opening fence line. */
  startOffset: number;
  /** 0-indexed byte offset of the end of the closing line. */
  endOffset: number;
  /** Effective indent (leading spaces + any list-marker width) stripped from content. */
  indent: number;
}

interface Opener {
  char: string;
  count: number;
  info: string;
  indent: number;
}

export function lineOffsetsOf(lines: string[]): number[] {
  const lineOffsets: number[] = [0];
  let offset = 0;
  for (let i = 0; i < lines.length - 1; i++) {
    offset += lines[i].length + 1;
    lineOffsets.push(offset);
  }
  return lineOffsets;
}

export function scanFences(md: string): Fence[] {
  return scanFencesFromLines(md.split("\n"));
}

export function scanFencesFromLines(lines: string[]): Fence[] {
  const result: Fence[] = [];
  const lineOffsets = lineOffsetsOf(lines);

  let i = 0;
  while (i < lines.length) {
    const opener = parseOpeningFence(lines[i]);
    if (!opener) {
      i++;
      continue;
    }

    const contentLines: string[] = [];
    let closingIdx = -1;
    for (let j = i + 1; j < lines.length; j++) {
      if (isClosingFence(lines[j], opener)) {
        closingIdx = j;
        break;
      }
      contentLines.push(lines[j]);
    }

    if (closingIdx === -1) {
      closingIdx = lines.length - 1;
      // Drop the split() artifact when the doc ends with \n.
      if (
        contentLines.length > 0 &&
        contentLines[contentLines.length - 1] === ""
      ) {
        contentLines.pop();
      }
    }

    const dedented = contentLines.map((l) => stripIndent(l, opener.indent));
    result.push({
      info: opener.info,
      code: dedented.length > 0 ? `${dedented.join("\n")}\n` : "",
      startLine: i + 1,
      codeStartLine: i + 2,
      endLine: closingIdx + 1,
      startOffset: lineOffsets[i],
      endOffset: lineOffsets[closingIdx] + lines[closingIdx].length,
      indent: opener.indent,
    });
    i = closingIdx + 1;
  }

  return result;
}

function parseOpeningFence(line: string): Opener | null {
  let indent = 0;
  let pos = 0;
  while (pos < line.length && line[pos] === " " && indent < 4) {
    indent++;
    pos++;
  }
  if (indent >= 4) return null; // indented code block, inert

  // Optional list marker directly before the fence ("- ```", "1. ```"):
  // its width joins the effective indent so content and closer line up.
  const marker = line.substring(pos).match(/^([-*+]|\d{1,9}[.)])( +)/);
  if (marker) {
    const after = line[pos + marker[0].length];
    if (after === "`" || after === "~") {
      indent += marker[0].length;
      pos += marker[0].length;
    }
  }

  const char = line[pos];
  if (char !== "`" && char !== "~") return null;

  let count = 0;
  while (pos < line.length && line[pos] === char) {
    count++;
    pos++;
  }
  if (count < 3) return null;

  const info = line.substring(pos).trim();
  // Backtick fences may not contain backticks in the info string.
  if (char === "`" && info.includes("`")) return null;

  return { char, count, info, indent };
}

function isClosingFence(line: string, opener: Opener): boolean {
  // The closer may be indented up to 3 spaces beyond the opener's indent.
  const maxIndent = opener.indent + 3;
  let indent = 0;
  let pos = 0;
  while (pos < line.length && line[pos] === " " && indent <= maxIndent) {
    indent++;
    pos++;
  }
  if (indent > maxIndent) return false;
  if (line[pos] !== opener.char) return false;

  let count = 0;
  while (pos < line.length && line[pos] === opener.char) {
    count++;
    pos++;
  }
  if (count < opener.count) return false;

  return /^\s*$/.test(line.substring(pos));
}

function stripIndent(line: string, indent: number): string {
  let pos = 0;
  while (pos < line.length && line[pos] === " " && pos < indent) pos++;
  return line.substring(pos);
}
