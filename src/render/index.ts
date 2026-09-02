/**
 * Render export surface: markdown, html, json, jsonl renderers.
 */

import type { Renderer } from "../ir/types";
import { htmlRenderer } from "./html";
import { jsonlRenderer, jsonRenderer } from "./json";
import { markdownRenderer } from "./markdown";

export const renderers: Record<string, Renderer> = {
  markdown: markdownRenderer,
  html: htmlRenderer,
  json: jsonRenderer,
  jsonl: jsonlRenderer,
};
