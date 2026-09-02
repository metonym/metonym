/**
 * HTML renderer: render markdown docs to HTML via Bun.markdown.html.
 * Reuses markdown renderer output to preserve annotations.
 */

import type {
  DocumentationSet,
  RenderedFile,
  Renderer,
  RenderOptions,
} from "../ir/types";
import { markdownRenderer } from "./markdown";

const CSS = `
  body {
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Oxygen, Ubuntu,
      Cantarell, sans-serif;
    line-height: 1.6;
    color: #333;
    background-color: #fafafa;
    margin: 0;
    padding: 20px;
  }

  main {
    max-width: 900px;
    margin: 0 auto;
    background-color: white;
    border-radius: 8px;
    box-shadow: 0 1px 3px rgba(0, 0, 0, 0.1);
    padding: 40px;
  }

  h1, h2, h3, h4, h5, h6 {
    margin-top: 1.5em;
    margin-bottom: 0.5em;
    font-weight: 600;
  }

  h1 {
    font-size: 2em;
    border-bottom: 2px solid #e1e4e8;
    padding-bottom: 0.3em;
  }

  pre {
    background-color: #f6f8fa;
    border-radius: 4px;
    padding: 12px;
    overflow-x: auto;
    font-size: 0.9em;
    line-height: 1.5;
  }

  code {
    font-family: "Courier New", Courier, monospace;
    background-color: #f6f8fa;
    padding: 0.2em 0.4em;
    border-radius: 2px;
  }

  pre code {
    background-color: transparent;
    padding: 0;
  }

  blockquote {
    border-left: 4px solid #d0d0d0;
    padding-left: 16px;
    margin-left: 0;
    margin-right: 0;
    color: #666;
    font-style: italic;
  }

  blockquote > p {
    margin: 0.5em 0;
  }

  blockquote[data-metonym] {
    background-color: #fffbea;
    border-left-color: #ffa500;
    color: #333;
    font-style: normal;
    padding: 12px;
    margin: 12px 0;
    border-radius: 4px;
  }

  blockquote[data-metonym="passed"] {
    background-color: #f0fdf4;
    border-left-color: #22c55e;
  }

  blockquote[data-metonym="failed"] {
    background-color: #fef2f2;
    border-left-color: #ef4444;
  }

  blockquote[data-metonym="pending"] {
    background-color: #f3f4f6;
    border-left-color: #9ca3af;
  }

  a {
    color: #0969da;
    text-decoration: none;
  }

  a:hover {
    text-decoration: underline;
  }

  table {
    border-collapse: collapse;
    width: 100%;
    margin: 1em 0;
  }

  th, td {
    border: 1px solid #d0d0d0;
    padding: 8px 12px;
    text-align: left;
  }

  th {
    background-color: #f6f8fa;
    font-weight: 600;
  }
`;

export const htmlRenderer: Renderer = {
  name: "html",
  async render(
    docs: DocumentationSet,
    options?: RenderOptions,
  ): Promise<{ files: RenderedFile[] }> {
    const mdResult = await markdownRenderer.render(docs, options);

    const files: RenderedFile[] = [];

    for (const mdFile of mdResult.files) {
      // .examples.md is already annotated markdown; pass through unchanged
      if (
        !mdFile.path.endsWith(".md") ||
        mdFile.path.endsWith(".examples.md")
      ) {
        if (mdFile.path.endsWith(".examples.md")) {
          files.push(mdFile);
        }
        continue;
      }

      const htmlPath = `${mdFile.path}.html`;
      const htmlContent = renderMarkdownToHtml(mdFile.contents, mdFile.path);

      files.push({
        path: htmlPath,
        contents: htmlContent,
      });
    }

    return { files };
  },
};

function renderMarkdownToHtml(markdown: string, docPath: string): string {
  const htmlBody = Bun.markdown.html(markdown);

  return `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<title>${docPath}</title>
<style>
${CSS}
</style>
</head>
<body>
<main>
${htmlBody}
</main>
</body>
</html>
`;
}
