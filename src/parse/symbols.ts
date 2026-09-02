/**
 * Shallow symbol extraction via Bun.Transpiler.scan.
 * Exports + import records only — no positions, no call graphs.
 * Enriched with declaration locations and kinds via scanDecls.
 */

import { symbolId } from "../ir/ids";
import type { SymbolInfo } from "../ir/types";
import { type Decl, scanDecls } from "./decls";
import { getTranspiler } from "./transpiler";

const LOADERS: Record<string, "ts" | "tsx" | "js" | "jsx"> = {
  ".ts": "ts",
  ".mts": "ts",
  ".cts": "ts",
  ".tsx": "tsx",
  ".js": "js",
  ".mjs": "js",
  ".cjs": "js",
  ".jsx": "jsx",
};

/**
 * Scan a source file's exports: names, positions, and declaration kinds.
 *
 * @example
 * ```ts
 * import { scanSymbols } from "metonym"
 *
 * const code = "export function add(a: number, b: number) { return a + b }"
 * const symbols = scanSymbols("math.ts", code)
 * expect(symbols[0].name).toBe("add")
 * expect(symbols[0].declKind).toBe("function")
 * ```
 */
export function scanSymbols(file: string, code: string): SymbolInfo[] {
  // No "export" anywhere means no symbols — skip the native parse entirely.
  if (!code.includes("export")) return [];

  const ext = file.slice(file.lastIndexOf("."));
  const loader = LOADERS[ext] ?? "ts";
  let scanned: { exports: string[]; imports: { path: string; kind: string }[] };
  try {
    const transpiler = getTranspiler(loader);
    scanned = transpiler.scan(code);
  } catch {
    return []; // unparseable source is not metonym's error to raise
  }

  let decls: Decl[] = [];
  try {
    decls = scanDecls(code);
  } catch {
    // Declaration scanning failure is non-fatal; proceed without enrichment
  }

  const declByName = new Map<string, Decl>();
  for (const decl of decls) {
    declByName.set(decl.name, decl);
  }

  const imports = scanned.imports.map(({ path, kind }) => ({ path, kind }));
  const symbols: SymbolInfo[] = scanned.exports
    .slice()
    .sort()
    .map((name) => {
      const decl = declByName.get(name);
      const info: SymbolInfo = {
        id: symbolId(file, name),
        file,
        name,
        imports,
      };

      if (decl) {
        info.loc = {
          file,
          start: { line: decl.line, column: decl.column, offset: decl.offset },
          end: { line: decl.line, column: decl.column, offset: decl.offset },
        };
        info.declKind = decl.declKind;
        if (decl.reexportFrom) {
          info.reexportFrom = decl.reexportFrom;
        }
      }

      return info;
    });

  // `Transpiler.scan().exports` only reports runtime-value exports, so
  // type-only declarations never appear there even though `scanDecls`
  // finds them — add those directly, plus a synthetic entry for
  // `export *` re-exports (also absent from `scanned.exports`).
  const exportNames = new Set(scanned.exports);
  for (const decl of decls) {
    if (decl.name === "*" && decl.reexportFrom) {
      symbols.push({
        id: symbolId(file, "*"),
        file,
        name: "*",
        imports,
        loc: {
          file,
          start: { line: decl.line, column: decl.column, offset: decl.offset },
          end: { line: decl.line, column: decl.column, offset: decl.offset },
        },
        declKind: "reexport",
        reexportFrom: decl.reexportFrom,
      });
      continue;
    }
    if (
      (decl.declKind === "interface" || decl.declKind === "type") &&
      !exportNames.has(decl.name)
    ) {
      symbols.push({
        id: symbolId(file, decl.name),
        file,
        name: decl.name,
        imports,
        loc: {
          file,
          start: { line: decl.line, column: decl.column, offset: decl.offset },
          end: { line: decl.line, column: decl.column, offset: decl.offset },
        },
        declKind: decl.declKind,
      });
    }
  }

  return symbols;
}
