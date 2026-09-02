/**
 * End-to-end: an MDX document with tsx examples executes against a
 * self-provided JSX runtime (package self-reference), and failures remap to
 * MDX line numbers. Guards the full jsxImportSource path, including Bun's
 * use of jsx-dev-runtime/jsxDEV in test transpilation.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { extract, generate, run, scan } from "metonym";

let root: string;

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "metonym-mdxtsx-"));
  await mkdir(join(root, "src"), { recursive: true });
  await mkdir(join(root, "docs"), { recursive: true });
  await Bun.write(
    join(root, "package.json"),
    JSON.stringify({
      name: "mini-jsx",
      exports: {
        ".": "./src/index.ts",
        "./jsx-runtime": "./src/jsx-runtime.ts",
        // Bun's test transpile targets jsx-dev-runtime (jsxDEV) — a custom
        // import source must export it or generated tsx tests fail to load.
        "./jsx-dev-runtime": "./src/jsx-dev-runtime.ts",
      },
      metonym: { jsxImportSource: "mini-jsx" },
    }),
  );
  await Bun.write(
    join(root, "src/jsx-runtime.ts"),
    "export function jsx(type: unknown, props: unknown) { return { type, props }; }\n" +
      "export const jsxs = jsx;\nexport const Fragment = 'fragment';\n",
  );
  await Bun.write(
    join(root, "src/jsx-dev-runtime.ts"),
    "export function jsxDEV(type: unknown, props: unknown) { return { type, props }; }\n" +
      "export const Fragment = 'fragment';\n",
  );
  await Bun.write(
    join(root, "src/index.ts"),
    "export function tagOf(el: { type: unknown }): unknown { return el.type; }\n",
  );
  await Bun.write(
    join(root, "docs/guide.mdx"),
    [
      'import { Chart } from "./chart"',
      'export const meta = { title: "Guide" }',
      "",
      "# Rendering",
      "",
      "<Chart data={[1, 2]} />",
      "",
      "{/* # not a real heading */}",
      "",
      "```tsx",
      'import { tagOf } from "mini-jsx"',
      "",
      'const el = <div title="hi">x</div>',
      'expect(tagOf(el)).toBe("div")',
      "```",
      "",
      "```tsx",
      'import { tagOf } from "mini-jsx"',
      "",
      "const el = <span>y</span>",
      'expect(tagOf(el)).toBe("div")', // deliberate failure, body line 4 → doc line 21
      "```",
      "",
    ].join("\n"),
  );
});

afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("mdx + tsx end-to-end", () => {
  test("tsx examples in MDX execute with a self-provided JSX runtime and remap failures", async () => {
    const project = await scan({ root });
    expect(project.docFiles).toContain("docs/guide.mdx");
    expect(project.config.jsxImportSource).toBe("mini-jsx");

    const docs = await extract(project);
    const doc = docs.documents.find((d) => d.file === "docs/guide.mdx");
    expect(doc?.origin).toBe("mdx");
    expect(doc?.title).toBe("Rendering"); // JSX-comment heading ignored
    expect(docs.examples.length).toBe(2);
    expect(docs.examples.every((e) => e.language === "tsx")).toBe(true);

    const generated = generate(docs, {
      jsxImportSource: project.config.jsxImportSource,
    });
    expect(generated[0].path).toBe("docs/guide.mdx.test.tsx");
    expect(
      generated[0].code.startsWith("/* @jsxImportSource mini-jsx */"),
    ).toBe(true);

    const result = await run(docs, {
      generated,
      outDir: join(root, ".metonym/tests"),
    });
    expect(result.totals.passed).toBe(1);
    expect(result.totals.failed).toBe(1);
    expect(result.totals.skipped).toBe(0); // load errors must not masquerade as skips

    const failure = result.results.find((r) => r.status === "failed");
    expect(failure?.failure?.doc).toEqual({
      file: "docs/guide.mdx",
      line: 21,
      column: expect.any(Number),
    });
    expect(failure?.failure?.expected).toBe('"div"');
    expect(failure?.failure?.received).toBe('"span"');
  }, 20000);
});
