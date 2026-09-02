/**
 * Markdown parser — extracts headings and fenced code blocks.
 */

import { createExampleIdAllocator, documentId } from "../ir/ids";
import type { Document, Example } from "../ir/types";
import { DEFAULT_CONFIG } from "../ir/types";
import { type Fence, lineOffsetsOf, scanFencesFromLines } from "./fence";
import { isExecutableLang, parseInfoString } from "./info";

export interface ExtractMarkdownResult {
  document: Document;
  examples: Example[];
}

interface Heading {
  text: string;
  line: number;
}

/**
 * Extract fenced code examples from Markdown text, with precise source
 * locations. Pure — no execution.
 *
 * @example
 * ```ts
 * import { extractMarkdown } from "metonym"
 *
 * const markdown = "# Hi\n\n```ts\nconst x = 1\n```\n"
 * const { examples } = extractMarkdown(markdown, { file: "virtual.md" })
 * expect(examples.length).toBe(1)
 * expect(examples[0].code).toBe("const x = 1\n")
 * ```
 */
export function extractMarkdown(
  text: string,
  opts: { file: string; languages?: string[] },
): ExtractMarkdownResult {
  const { file } = opts;
  const languages = opts.languages ?? DEFAULT_CONFIG.languages;

  const lines = text.split("\n");
  const lineOffsets = lineOffsetsOf(lines);
  const fences = scanFencesFromLines(lines);

  const headings = extractHeadings(lines, fences);

  const basename = file.split("/").pop() || file;
  const isReadme = basename.toLowerCase() === "readme.md";
  const isMdx = file.toLowerCase().endsWith(".mdx");

  // MDX: headings inside multi-line JSX comments ({/* … */}) are not real
  // headings. (Other MDX constructs — imports/exports/JSX blocks — never
  // match a fence opener or an ATX heading, so no further guards needed.)
  const effectiveHeadings = isMdx
    ? filterJsxCommentHeadings(lines, headings, fences)
    : headings;
  const title =
    effectiveHeadings.length > 0 ? effectiveHeadings[0].text : undefined;

  const document: Document = {
    id: documentId(file),
    file,
    origin: isReadme ? "readme" : isMdx ? "mdx" : "markdown",
    title,
    exampleIds: [],
  };

  const examples: Example[] = [];
  const allocator = createExampleIdAllocator(file);

  const headingScopes = new Map<number, number>();

  for (const fence of fences) {
    const info = parseInfoString(fence.info);
    if (!isExecutableLang(info.lang, languages) || info.kind === "ignored") {
      continue;
    }

    let nearestHeading: Heading | undefined;
    let headingIndex = -1;
    for (let i = 0; i < effectiveHeadings.length; i++) {
      if (effectiveHeadings[i].line < fence.startLine) {
        nearestHeading = effectiveHeadings[i];
        headingIndex = i;
      } else {
        break;
      }
    }

    const scopeKey = nearestHeading ? headingIndex : -1;
    const counter = (headingScopes.get(scopeKey) ?? 0) + 1;
    headingScopes.set(scopeKey, counter);

    const titlePrefix = nearestHeading ? nearestHeading.text : basename;
    const exampleTitle = `${titlePrefix} › example ${counter}`;

    const codeStartLine = fence.codeStartLine;
    const codeEndLine =
      fence.code.length === 0 ? codeStartLine : fence.endLine - 1;

    const codeStartColumn = fence.indent + 1;
    const codeStartOffset = lineOffsets[codeStartLine - 1] + fence.indent;

    const codeEndColumn = 1;
    let codeEndOffset = lineOffsets[codeEndLine - 1];
    if (codeEndLine <= lines.length) {
      codeEndOffset += lines[codeEndLine - 1].length;
    }

    const id = allocator(fence.code);

    const example: Example = {
      id,
      documentId: document.id,
      source: {
        file,
        start: {
          line: codeStartLine,
          column: codeStartColumn,
          offset: codeStartOffset,
        },
        end: {
          line: codeEndLine,
          column: codeEndColumn,
          offset: codeEndOffset,
        },
      },
      fenceSource: {
        file,
        start: {
          line: fence.startLine,
          column: 1,
          offset: fence.startOffset,
        },
        end: {
          line: fence.endLine,
          column: 1,
          offset: fence.endOffset,
        },
      },
      language: info.lang,
      code: fence.code,
      kind: info.kind,
      group: info.group,
      title: exampleTitle,
    };

    examples.push(example);
    document.exampleIds.push(example.id);
  }

  return { document, examples };
}

function extractHeadings(lines: string[], fences: Fence[]): Heading[] {
  const headings: Heading[] = [];
  const atxRegex = /^ {0,3}(#{1,6})\s+(.+?)\s*#*\s*$/;
  let f = 0;

  for (let i = 0; i < lines.length; i++) {
    const lineNum = i + 1;
    while (f < fences.length && fences[f].endLine < lineNum) f++;
    if (
      f < fences.length &&
      lineNum >= fences[f].startLine &&
      lineNum <= fences[f].endLine
    ) {
      continue;
    }

    const match = lines[i].match(atxRegex);
    if (match) {
      headings.push({
        text: match[2].trim(),
        line: lineNum,
      });
    }
  }

  return headings;
}

// Drop headings that fall inside multi-line MDX/JSX comment blocks
// (curly-brace slash-star … star-slash-brace). Line-based: tracks open/close
// markers outside fenced code blocks.
function filterJsxCommentHeadings(
  lines: string[],
  headings: Heading[],
  fences: Fence[],
): Heading[] {
  const commentLines = new Set<number>();
  let depth = 0;
  let f = 0;
  for (let i = 0; i < lines.length; i++) {
    const lineNum = i + 1;
    while (f < fences.length && fences[f].endLine < lineNum) f++;
    if (
      f < fences.length &&
      lineNum >= fences[f].startLine &&
      lineNum <= fences[f].endLine
    ) {
      continue;
    }
    const opens = lines[i].split("{/*").length - 1;
    const closes = lines[i].split("*/}").length - 1;
    if (depth > 0) commentLines.add(lineNum);
    depth = Math.max(0, depth + opens - closes);
    if (opens > 0) commentLines.add(lineNum);
  }
  return headings.filter((h) => !commentLines.has(h.line));
}
