import { expect, test } from "bun:test";
import { extractMarkdown } from "metonym";

test("markdown: basic ts fence becomes an assertion example", () => {
  const text = `# Title
\`\`\`ts
expect(1).toBe(1)
\`\`\``;

  const { document, examples } = extractMarkdown(text, { file: "test.md" });

  expect(examples.length).toBe(1);
  expect(examples[0].code).toBe("expect(1).toBe(1)\n");
  expect(examples[0].kind).toBe("assertion");
  expect(examples[0].language).toBe("ts");
  expect(examples[0].source.start.line).toBe(3);
  expect(document.origin).toBe("markdown");
});

test("markdown: README.md gets origin=readme", () => {
  const text = `# Title
\`\`\`ts
test()
\`\`\``;

  const { document } = extractMarkdown(text, { file: "README.md" });
  expect(document.origin).toBe("readme");
});

test("markdown: first heading becomes document title", () => {
  const text = `# Main Title
## Subtitle
\`\`\`ts
test()
\`\`\``;

  const { document } = extractMarkdown(text, { file: "test.md" });
  expect(document.title).toBe("Main Title");
});

test("markdown: heading-scoped titles and per-heading numbering", () => {
  const text = `# Section A
\`\`\`ts
example1()
\`\`\`

\`\`\`ts
example2()
\`\`\`

# Section B
\`\`\`ts
example3()
\`\`\`

\`\`\`ts
example4()
\`\`\``;

  const { examples } = extractMarkdown(text, { file: "test.md" });
  expect(examples.length).toBe(4);

  expect(examples[0].title).toBe("Section A › example 1");
  expect(examples[1].title).toBe("Section A › example 2");
  expect(examples[2].title).toBe("Section B › example 1");
  expect(examples[3].title).toBe("Section B › example 2");
});

test("markdown: ignore and non-executable langs excluded", () => {
  const text = `\`\`\`json
{"test": true}
\`\`\`

\`\`\`text
some text
\`\`\`

\`\`\`ts ignore
ignored_code()
\`\`\`

\`\`\`ts
executed()
\`\`\``;

  const { examples } = extractMarkdown(text, { file: "test.md" });
  expect(examples.length).toBe(1);
  expect(examples[0].code.trim()).toBe("executed()");
});

test("markdown: kinds are captured", () => {
  const text = `\`\`\`ts no-run
no_run_example()
\`\`\`

\`\`\`ts throws
throws_example()
\`\`\`

\`\`\`ts pending
pending_example()
\`\`\`

\`\`\`ts
assertion_example()
\`\`\``;

  const { examples } = extractMarkdown(text, { file: "test.md" });
  expect(examples.length).toBe(4);

  expect(examples[0].kind).toBe("no-run");
  expect(examples[1].kind).toBe("throws");
  expect(examples[2].kind).toBe("pending");
  expect(examples[3].kind).toBe("assertion");
});

test("markdown: group attribute is captured", () => {
  const text = `\`\`\`ts group=setup
setup_code()
\`\`\`

\`\`\`ts group=setup
more_setup()
\`\`\`

\`\`\`ts
no_group()
\`\`\``;

  const { examples } = extractMarkdown(text, { file: "test.md" });
  expect(examples.length).toBe(3);

  expect(examples[0].group).toBe("setup");
  expect(examples[1].group).toBe("setup");
  expect(examples[2].group).toBeUndefined();
});

test("markdown: exact source.start line numbers", () => {
  const text = `# Heading
\`\`\`ts
code_line_1
code_line_2
\`\`\``;

  const { examples } = extractMarkdown(text, { file: "test.md" });
  expect(examples.length).toBe(1);
  expect(examples[0].source.start.line).toBe(3);
  expect(examples[0].source.end.line).toBe(4);
});

test("markdown: two identical code bodies get ids differing by ~1 suffix", () => {
  const text = `\`\`\`ts
same_code()
\`\`\`

\`\`\`ts
same_code()
\`\`\``;

  const { examples } = extractMarkdown(text, { file: "test.md" });
  expect(examples.length).toBe(2);

  expect(examples[0].id).not.toBe(examples[1].id);
  expect(examples[1].id).toContain("~1");
});

test("markdown: unclosed fence at EOF is safe", () => {
  const text = `# Heading
\`\`\`ts
some_code()`;

  const { examples } = extractMarkdown(text, { file: "test.md" });
  expect(examples.length).toBe(1);
  expect(examples[0].code).toBe("some_code()\n");
});

test("markdown: examples before any heading use file name as scope", () => {
  const text = `\`\`\`ts
example1()
\`\`\`

\`\`\`ts
example2()
\`\`\`

# Heading
\`\`\`ts
example3()
\`\`\``;

  const { examples } = extractMarkdown(text, { file: "test.md" });
  expect(examples.length).toBe(3);

  expect(examples[0].title).toContain("test.md › example 1");
  expect(examples[1].title).toContain("test.md › example 2");
  expect(examples[2].title).toContain("Heading › example 1");
});

test("markdown: source location has exact offsets", () => {
  const text = `# Heading\n\`\`\`ts\ncode()\n\`\`\``;

  const { examples } = extractMarkdown(text, { file: "test.md" });
  expect(examples.length).toBe(1);

  const example = examples[0];
  // Line 1: "# Heading" (9 chars) + \n = 10
  // Line 2: "```ts" (5 chars) + \n = 6
  // Line 3: "code()" (6 chars) at position 16

  expect(example.source.start.offset).toBe(16);
});

test("markdown: custom languages configuration", () => {
  const text = `\`\`\`ts
ts_code()
\`\`\`

\`\`\`js
js_code()
\`\`\`

\`\`\`tsx
tsx_code()
\`\`\``;

  const { examples: allExamples } = extractMarkdown(text, {
    file: "test.md",
  });
  expect(allExamples.length).toBe(3);

  const { examples: onlyTs } = extractMarkdown(text, {
    file: "test.md",
    languages: ["ts"],
  });
  expect(onlyTs.length).toBe(1);
  expect(onlyTs[0].code.trim()).toBe("ts_code()");
});

test("markdown: fenceSource captures fence delimiters", () => {
  const text = `line1
line2
\`\`\`ts
code()
\`\`\`
line6`;

  const { examples } = extractMarkdown(text, { file: "test.md" });
  expect(examples.length).toBe(1);

  expect(examples[0].fenceSource.start.line).toBe(3);
  expect(examples[0].fenceSource.end.line).toBe(5);
});

test("markdown: empty fence creates example with empty code", () => {
  const text = `\`\`\`ts
\`\`\``;

  const { examples } = extractMarkdown(text, { file: "test.md" });
  expect(examples.length).toBe(1);
  expect(examples[0].code).toBe("");
});

test("markdown: indented fence respects indent", () => {
  const text = `  \`\`\`ts
  code()
  \`\`\``;

  const { examples } = extractMarkdown(text, { file: "test.md" });
  expect(examples.length).toBe(1);
  expect(examples[0].code.trim()).toBe("code()");
});
