/**
 * In-memory ostia benches for the extract hot path.
 * These run on every doc and source file during extract(); no filesystem.
 */

import { group, task } from "ostia";
import { scanDecls } from "../src/parse/decls";
import { scanFences } from "../src/parse/fence";
import {
  extractDocComments,
  extractJsdoc,
  extractJsdocBlocks,
} from "../src/parse/jsdoc";
import { extractMarkdown } from "../src/parse/markdown";
import { scanSymbols } from "../src/parse/symbols";

function markdownDoc(fences: number): string {
  const parts: string[] = ["# Doc\n"];
  for (let i = 0; i < fences; i++) {
    parts.push(`## Heading ${i + 1}\n`);
    parts.push(`Paragraph ${i + 1}.\n`);
    parts.push("```ts\n");
    parts.push(`const x${i} = ${i};\n`);
    parts.push(`expect(x${i}).toBe(${i});\n`);
    parts.push("```\n");
    if (i % 3 === 0) {
      parts.push("```json\n");
      parts.push(`{"i": ${i}}\n`);
      parts.push("```\n");
    }
  }
  return parts.join("\n");
}

function jsdocModule(fns: number): string {
  const parts: string[] = [];
  for (let i = 0; i < fns; i++) {
    const name = `fn${i}`;
    if (i % 2 === 0) {
      parts.push(`/**
 * Function ${name}.
 *
 * @example
 * \`\`\`ts
 * const result = ${name}(${i});
 * expect(result).toBe(${i * 10});
 * \`\`\`
 */`);
    }
    parts.push(`export function ${name}(n: number): number {
  return n * ${i + 1};
}
`);
  }
  return parts.join("\n");
}

const MD = {
  small: markdownDoc(2),
  medium: markdownDoc(8),
  large: markdownDoc(40),
};

const TS = {
  small: jsdocModule(2),
  medium: jsdocModule(8),
  large: jsdocModule(40),
};

group("scanFences", () => {
  task("small (2 fences)", () => scanFences(MD.small));
  task("medium (8 fences)", () => scanFences(MD.medium));
  task("large (40 fences)", () => scanFences(MD.large));
});

group("extractMarkdown", () => {
  task("small (2 fences)", () =>
    extractMarkdown(MD.small, { file: "small.md" }),
  );
  task("medium (8 fences)", () =>
    extractMarkdown(MD.medium, { file: "medium.md" }),
  );
  task("large (40 fences)", () =>
    extractMarkdown(MD.large, { file: "large.md" }),
  );
});

group("extractJsdoc", () => {
  task("small (2 functions)", () =>
    extractJsdoc(TS.small, { file: "small.ts" }),
  );
  task("medium (8 functions)", () =>
    extractJsdoc(TS.medium, { file: "medium.ts" }),
  );
  task("large (40 functions)", () =>
    extractJsdoc(TS.large, { file: "large.ts" }),
  );
});

group("extractSourceCpu", () => {
  for (const [label, source] of [
    ["small (2 functions)", TS.small],
    ["medium (8 functions)", TS.medium],
    ["large (40 functions)", TS.large],
  ] as const) {
    task(label, () => {
      const file = "mod.ts";
      const blocks = extractJsdocBlocks(source);
      extractJsdoc(source, { file, blocks });
      return extractDocComments(source, { file, blocks });
    });
  }
});

group("scanSymbols", () => {
  task("small (2 functions)", () => scanSymbols("small.ts", TS.small));
  task("medium (8 functions)", () => scanSymbols("medium.ts", TS.medium));
  task("large (40 functions)", () => scanSymbols("large.ts", TS.large));
});

group("scanDecls", () => {
  task("small (2 functions)", () => scanDecls(TS.small));
  task("medium (8 functions)", () => scanDecls(TS.medium));
  task("large (40 functions)", () => scanDecls(TS.large));
});
