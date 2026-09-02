/**
 * Fence info-string parsing.
 *
 * Grammar: `<lang> [attr…]` where attrs are whitespace-separated tokens:
 *   ignore | no-run | throws | pending | group=<name>
 * Unknown tokens are preserved in `unknown` and otherwise ignored.
 * Kind precedence when several are present (deterministic, most-inert wins):
 *   ignore > pending > throws > no-run > assertion.
 */

import type { Example, ExampleKind } from "../ir/types";

export interface InfoString {
  lang: string;
  kind: ExampleKind;
  group?: string;
  unknown: string[];
}

const EXECUTABLE_LANGS = new Set(["ts", "tsx", "js", "jsx"]);

/**
 * Parse a fence info string into language, example kind, and attributes.
 *
 * @example
 * ```ts
 * import { parseInfoString } from "metonym"
 *
 * const info = parseInfoString("ts throws group=setup")
 * expect(info.lang).toBe("ts")
 * expect(info.kind).toBe("throws")
 * expect(info.group).toBe("setup")
 * ```
 */
export function parseInfoString(info: string): InfoString {
  const tokens = info.trim().split(/\s+/).filter(Boolean);
  const lang = tokens[0] ?? "";
  const attrs = tokens.slice(1);

  let ignore = false;
  let pending = false;
  let throws = false;
  let noRun = false;
  let group: string | undefined;
  const unknown: string[] = [];

  for (const t of attrs) {
    if (t === "ignore") ignore = true;
    else if (t === "pending") pending = true;
    else if (t === "throws") throws = true;
    else if (t === "no-run") noRun = true;
    else if (t.startsWith("group=") && t.length > 6) group = t.slice(6);
    else unknown.push(t);
  }

  const kind: ExampleKind = ignore
    ? "ignored"
    : pending
      ? "pending"
      : throws
        ? "throws"
        : noRun
          ? "no-run"
          : "assertion";

  return { lang, kind, group, unknown };
}

export function isExecutableLang(
  lang: string,
  configured: string[],
): lang is Example["language"] {
  return configured.includes(lang) && EXECUTABLE_LANGS.has(lang);
}
