/**
 * JSDoc parser — extracts @example blocks from comment sections.
 */

import { createExampleIdAllocator, documentId, symbolId } from "../ir/ids";
import type { Document, Example } from "../ir/types";
import { DEFAULT_CONFIG } from "../ir/types";
import { isWhitespaceCode } from "./chars";
import { lineOffsetsOf, scanFences } from "./fence";
import { isExecutableLang, parseInfoString } from "./info";

export interface ExtractJsdocResult {
  document: Document | null;
  examples: Example[];
}

export interface DocComment {
  /** Exported declaration name the comment documents ("default" for export default), or null if not attached to a recognizable declaration. */
  declName: string | null;
  /** 1-indexed line of the comment's opening slash-star-star. */
  line: number;
  /** Prose before the first @tag, trimmed; "" if none. */
  description: string;
  /** tag name (no @) → one entry per occurrence, each the tag's full text (multi-line continuation joined with \n), trimmed. @example content EXCLUDED (that's the examples pipeline). */
  tags: Record<string, string[]>;
}

export interface JsdocBlock {
  startLine: number;
  endLine: number;
  lines: string[];
}

interface CommentStrip {
  original: string;
  stripped: string;
  charsStripped: number;
}

interface ExampleSection {
  startLine: number;
  endLine: number;
  text: string;
}

export function extractJsdoc(
  source: string,
  opts: {
    file: string;
    languages?: string[];
    blocks?: JsdocBlock[];
    lines?: string[];
    lineOffsets?: number[];
  },
): ExtractJsdocResult {
  const { file } = opts;
  const languages = opts.languages ?? DEFAULT_CONFIG.languages;

  const lines = opts.lines ?? source.split("\n");
  const lineOffsets = opts.lineOffsets ?? lineOffsetsOf(lines);
  const blocks = opts.blocks ?? extractJsdocBlocksFromLines(lines);

  const examples: Example[] = [];
  const allocator = createExampleIdAllocator(file);
  const docId = documentId(file);
  const documentExampleIds: string[] = [];
  let foundExamples = false;
  let exampleCounter = 0;

  for (const block of blocks) {
    let owner: string | undefined;
    let declName: string | undefined;

    const declLine = findNextNonBlank(lines, block.endLine);
    if (declLine !== -1) {
      const match = lines[declLine].match(
        /^\s*(?:export\s+)?(?:default\s+)?(?:abstract\s+)?(?:async\s+)?(?:function\*?|class|const|let|var|enum)\s+([A-Za-z_$][\w$]*)/,
      );
      if (match) {
        declName = match[1];

        const isExported = /^\s*export\s+/.test(lines[declLine]);
        if (isExported) {
          owner = symbolId(file, declName);
        }
      }
    }

    const exampleSections = extractExampleSections(block, block.startLine);

    for (const section of exampleSections) {
      exampleCounter++;

      const fences = scanFences(section.text);

      if (fences.length > 0) {
        for (const fence of fences) {
          const info = parseInfoString(fence.info);
          if (
            !isExecutableLang(info.lang, languages) ||
            info.kind === "ignored"
          ) {
            continue;
          }

          foundExamples = true;
          const id = allocator(fence.code);
          const titlePrefix = declName || file;
          const exampleTitle = `${titlePrefix} › example ${exampleCounter}`;

          // Fence lines are 1-indexed in the @example section; section.startLine is 1-indexed in the file.
          const realStartLine = section.startLine + fence.codeStartLine - 1;
          const realEndLine =
            fence.code.length === 0
              ? realStartLine
              : section.startLine + fence.endLine - 2;

          const codeStartColumn = fence.indent + 1;
          const codeStartOffset = lineOffsets[realStartLine - 1] + fence.indent;

          const codeEndColumn = 1;
          const codeEndOffset =
            lineOffsets[realEndLine - 1] +
            (realEndLine <= lines.length ? lines[realEndLine - 1].length : 0);

          const example: Example = {
            id,
            documentId: docId,
            source: {
              file,
              start: {
                line: realStartLine,
                column: codeStartColumn,
                offset: codeStartOffset,
              },
              end: {
                line: realEndLine,
                column: codeEndColumn,
                offset: codeEndOffset,
              },
            },
            fenceSource: {
              file,
              start: {
                line: section.startLine + fence.startLine - 1,
                column: 1,
                offset:
                  lineOffsets[section.startLine + fence.startLine - 2] || 0,
              },
              end: {
                line: section.startLine + fence.endLine - 1,
                column: 1,
                offset: lineOffsets[section.startLine + fence.endLine - 2] || 0,
              },
            },
            language: info.lang,
            code: fence.code,
            kind: info.kind,
            group: info.group,
            owner,
            title: exampleTitle,
          };

          examples.push(example);
          documentExampleIds.push(example.id);
        }
      } else {
        // No fences, treat the whole section as a ts assertion example
        const nonBlankContent = section.text
          .split("\n")
          .some((line) => line.trim().length > 0);

        if (nonBlankContent) {
          foundExamples = true;
          const id = allocator(section.text);
          const titlePrefix = declName || file;
          const exampleTitle = `${titlePrefix} › example ${exampleCounter}`;

          const example: Example = {
            id,
            documentId: docId,
            source: {
              file,
              start: {
                line: section.startLine,
                column: 1,
                offset: lineOffsets[section.startLine - 1] ?? 0,
              },
              end: {
                line: section.endLine,
                column: 1,
                offset: lineOffsets[section.endLine - 1] || source.length,
              },
            },
            fenceSource: {
              file,
              start: {
                line: section.startLine,
                column: 1,
                offset: lineOffsets[section.startLine - 1] ?? 0,
              },
              end: {
                line: section.endLine,
                column: 1,
                offset: lineOffsets[section.endLine - 1] || source.length,
              },
            },
            language: "ts",
            code: section.text,
            kind: "assertion",
            owner,
            title: exampleTitle,
          };

          examples.push(example);
          documentExampleIds.push(example.id);
        }
      }
    }
  }

  const document: Document | null = foundExamples
    ? {
        id: docId,
        file,
        origin: "jsdoc",
        exampleIds: documentExampleIds,
      }
    : null;

  return { document, examples };
}

export function extractJsdocBlocks(
  source: string,
  lines?: string[],
): JsdocBlock[] {
  if (!source.includes("/**")) {
    return [];
  }
  return extractJsdocBlocksFromLines(lines ?? source.split("\n"));
}

function extractJsdocBlocksFromLines(lines: string[]): JsdocBlock[] {
  const blocks: JsdocBlock[] = [];
  let i = 0;
  while (i < lines.length) {
    const openIdx = lines[i].indexOf("/**");
    if (openIdx !== -1) {
      const startLine = i;

      // Self-closing single-line block, e.g. `/** Doubles a number. */` —
      // without this check the scan below starts looking for `*/` on the
      // *next* line, swallowing the declaration this comment documents
      // (and everything up to the next `*/` anywhere in the file) into the
      // comment body.
      if (lines[i].indexOf("*/", openIdx + 3) !== -1) {
        blocks.push({
          startLine: startLine + 1,
          endLine: startLine + 1,
          lines: [lines[i]],
        });
        i++;
        continue;
      }

      const blockLines = [lines[i]];

      let foundEnd = false;
      let j = i + 1;

      while (j < lines.length && !foundEnd) {
        const line = lines[j];
        blockLines.push(line);

        if (line.includes("*/")) {
          foundEnd = true;
        }
        j++;
      }

      blocks.push({
        startLine: startLine + 1,
        endLine: j,
        lines: blockLines,
      });

      i = j;
    } else {
      i++;
    }
  }

  return blocks;
}

// extractJsdoc and extractDocComments both strip the same blocks; share
// the result so a source file is prefix-stripped once, not twice.
const strippedBlocks = new WeakMap<JsdocBlock, CommentStrip[]>();

function strippedOf(block: JsdocBlock): CommentStrip[] {
  let stripped = strippedBlocks.get(block);
  if (!stripped) {
    stripped = stripCommentPrefixes(block.lines);
    strippedBlocks.set(block, stripped);
  }
  return stripped;
}

function stripCommentPrefixes(lines: string[]): CommentStrip[] {
  const out: CommentStrip[] = new Array(lines.length);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    let pos = 0;
    while (pos < line.length && isWhitespaceCode(line.charCodeAt(pos))) {
      pos++;
    }

    if (line.charCodeAt(pos) === 42 /* * */) {
      pos++;
      if (line.charCodeAt(pos) === 32 /* space */) {
        pos++;
      }
    }

    out[i] = {
      original: line,
      stripped: line.substring(pos),
      charsStripped: pos,
    };
  }
  return out;
}

/** True when the stripped line starts a `@tag`. Cheap first-char guard before the regex. */
function isTagLine(line: string): boolean {
  return line.charCodeAt(0) === 64 /* @ */ && /^@\w/.test(line);
}

function extractExampleSections(
  block: JsdocBlock,
  blockStartLine: number,
): ExampleSection[] {
  const stripped = strippedOf(block);

  const sections: ExampleSection[] = [];

  for (let i = 0; i < stripped.length; i++) {
    const line = stripped[i].stripped;
    const match = line.startsWith("@example")
      ? line.match(/^@example\s*(.*)?$/)
      : null;

    if (match) {
      const contentStart = i + 1;
      let contentEnd = stripped.length;

      for (let j = contentStart; j < stripped.length; j++) {
        if (isTagLine(stripped[j].stripped)) {
          contentEnd = j;
          break;
        }
      }

      const sectionLines: string[] = [];
      for (let j = contentStart; j < contentEnd; j++) {
        sectionLines.push(stripped[j].stripped);
      }

      const sectionText = sectionLines.join("\n");

      sections.push({
        startLine: blockStartLine + contentStart,
        endLine: blockStartLine + contentEnd - 1,
        text: sectionText,
      });
    }
  }

  return sections;
}

function findNextNonBlank(lines: string[], startLine: number): number {
  for (let i = startLine; i < lines.length; i++) {
    if (lines[i].trim().length > 0) {
      return i;
    }
  }
  return -1;
}

/**
 * Extract JSDoc prose and tags from a source file.
 * Returns one DocComment per JSDoc block, in source order.
 * Descriptions exclude @tags. Tags exclude @example (that's the examples pipeline).
 * declName is null for non-exported declarations or file-level comments.
 */
export function extractDocComments(
  source: string,
  opts: { file: string; blocks?: JsdocBlock[]; lines?: string[] },
): DocComment[] {
  const lines = opts.lines ?? source.split("\n");
  const blocks = opts.blocks ?? extractJsdocBlocksFromLines(lines);
  const results: DocComment[] = [];

  for (const block of blocks) {
    const stripped = cleanDelimiterRemnants(strippedOf(block));

    const description = extractDescription(stripped);

    const tags = extractTags(stripped);

    let declName: string | null = null;
    const nextLineIdx = block.endLine;
    if (nextLineIdx < lines.length) {
      if (lines[nextLineIdx].trim().length > 0) {
        declName = extractDeclName(lines[nextLineIdx], lines);
      }
      // If it's a blank line, the declaration is too far away → banner comment
    }

    const comment: DocComment = {
      declName,
      line: block.startLine,
      description,
      tags,
    };

    results.push(comment);
  }

  return results;
}

/**
 * Remove comment-delimiter remnants that survive prefix stripping: pure
 * delimiter lines, the opening slash-star-star on the first content line,
 * and the closing star-slash remnant (which strips down to a bare "/").
 */
function cleanDelimiterRemnants(strips: CommentStrip[]): CommentStrip[] {
  const out: CommentStrip[] = [];
  for (const s of strips) {
    const orig = s.original.trim();
    if (orig === "/**" || orig === "*/") continue;
    let line = s.stripped.replace(/^\/\*\*\s?/, "");
    if (orig.endsWith("*/")) {
      line = line.replace(/\s*\*?\/\s*$/, "");
      if (line.trim() === "") continue;
    }
    out.push({ ...s, stripped: line });
  }
  return out;
}

function extractDescription(stripped: CommentStrip[]): string {
  const descriptionLines: string[] = [];

  for (const strip of stripped) {
    const line = strip.stripped;

    if (line === "/**" || line === "/*" || line === "*/" || line === "*/") {
      continue;
    }

    if (isTagLine(line)) {
      break;
    }
    descriptionLines.push(line);
  }

  // Trim leading and trailing blank lines, but preserve internal blank lines
  while (descriptionLines.length > 0 && !descriptionLines[0].trim()) {
    descriptionLines.shift();
  }
  while (
    descriptionLines.length > 0 &&
    !descriptionLines[descriptionLines.length - 1].trim()
  ) {
    descriptionLines.pop();
  }

  return descriptionLines.join("\n").trim();
}

/**
 * Extract all tags from stripped comment lines (excluding @example).
 * Returns a map of tag name (without @) to array of tag values.
 * Multi-line tag continuations are joined with \n.
 */
function extractTags(stripped: CommentStrip[]): Record<string, string[]> {
  const tags: Record<string, string[]> = {};
  let i = 0;

  while (i < stripped.length) {
    const line = stripped[i].stripped;

    if (line === "/**" || line === "/*" || line === "*/" || line === "*/") {
      i++;
      continue;
    }

    const match =
      line.charCodeAt(0) === 64 /* @ */
        ? line.match(/^@([A-Za-z][\w-]*)\b\s*(.*?)$/)
        : null;

    if (match) {
      const tagName = match[1];
      if (tagName === "example") {
        i++;
        while (i < stripped.length) {
          const nextLine = stripped[i].stripped;
          if (
            nextLine === "/**" ||
            nextLine === "/*" ||
            nextLine === "*/" ||
            nextLine === "*/"
          ) {
            i++;
            continue;
          }
          if (isTagLine(nextLine)) {
            break;
          }
          i++;
        }
        continue;
      }

      const tagLines: string[] = [match[2]];
      i++;

      while (i < stripped.length) {
        const nextLine = stripped[i].stripped;
        if (
          nextLine === "/**" ||
          nextLine === "/*" ||
          nextLine === "*/" ||
          nextLine === "*/"
        ) {
          i++;
          continue;
        }
        if (isTagLine(nextLine)) {
          break;
        }
        tagLines.push(nextLine);
        i++;
      }

      const tagValue = tagLines.join("\n").trim();

      if (!tags[tagName]) {
        tags[tagName] = [];
      }
      tags[tagName].push(tagValue);
    } else {
      i++;
    }
  }

  return tags;
}

/**
 * Extract declaration name from a line, handling export syntax.
 * Matches: export function/class/const/let/var/enum NAME, export interface NAME, export type NAME, export default.
 * Returns the name or "default" for export default, or null if no match.
 */
function extractDeclName(declLine: string, _allLines: string[]): string | null {
  if (/^\s*export\s+default\b/.test(declLine)) {
    const nameMatch = declLine.match(
      /^\s*export\s+default\s+(?:(?:function|class|const|let|var|enum|interface|type)\s+)?([A-Za-z_$][\w$]*)/,
    );
    if (nameMatch?.[1]) {
      return nameMatch[1];
    }
    return "default";
  }

  const match = declLine.match(
    /^\s*export\s+(?:abstract\s+)?(?:async\s+)?(?:function\*?|class|const|let|var|enum|interface|type)\s+([A-Za-z_$][\w$]*)/,
  );
  if (match) {
    return match[1];
  }

  const nonExportMatch = declLine.match(
    /^\s*(?:abstract\s+)?(?:async\s+)?(?:function\*?|class|const|let|var|enum|interface|type)\s+([A-Za-z_$][\w$]*)/,
  );
  if (nonExportMatch) {
    if (/^\s*export\s+/.test(declLine)) {
      return nonExportMatch[1];
    }
    return null;
  }

  return null;
}
