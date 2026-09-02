/**
 * Shared ANSI color helpers for CLI output, gated on stderr being a TTY
 * (every diagnostic/error/warning in this CLI prints there). Hardcoded
 * SGR codes rather than Bun.color: Bun.color's "ansi" auto-detect depends
 * on COLORTERM being set (misses plenty of real terminals that do support
 * color), and its nearest-match for plain names like "red"/"yellow" picks
 * the bright variants (91/93) — getting the classic codes back requires
 * passing names like "darkred"/"olive", which isn't worth the indirection
 * for a fixed three-color palette.
 */
const isTTY = process.stderr.isTTY === true;

const paint =
  (code: number) =>
  (s: string): string =>
    isTTY ? `\x1b[${code}m${s}\x1b[0m` : s;

export const c = {
  green: paint(32),
  red: paint(31),
  yellow: paint(33),
  dim: paint(2),
  bold: paint(1),
};
