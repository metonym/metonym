/**
 * Static import statement parser.
 * Extracts import bindings (local name, imported name, module specifier).
 */

export interface ImportBinding {
  local: string; // name bound in local scope
  imported: string; // exported name from module; "default" for defaults, "*" for namespace
  specifier: string; // module specifier (unquoted)
}

/**
 * Check whether `text` — a statement, possibly with continuation lines
 * already joined by spaces — is a syntactically terminated import.
 */
export function isCompleteImportStatement(text: string): boolean {
  const trimmed = text.trim();
  return (
    /^import\s*["'][^"']+["']\s*;?\s*$/.test(trimmed) ||
    /from\s+["'][^"']+["']\s*(?:(?:with|assert)\s*\{[^{}]*\}\s*)?;?\s*$/.test(
      trimmed,
    ) ||
    /=\s*require\(\s*["'][^"']+["']\s*\)\s*;?\s*$/.test(trimmed)
  );
}

/**
 * Join a statement that may span multiple lines, starting at `lines[startIdx]`.
 * Consumes lines until `isComplete` is satisfied (or input runs out),
 * collapsing internal whitespace while preserving the first line's indent.
 */
export function joinStatementLines(
  lines: string[],
  startIdx: number,
  isComplete: (text: string) => boolean,
): { statement: string; consumed: number } {
  const leading = lines[startIdx].match(/^\s*/)?.[0] ?? "";
  let text = lines[startIdx].trim();
  let consumed = 1;
  while (!isComplete(text) && startIdx + consumed < lines.length) {
    text = `${text} ${lines[startIdx + consumed].trim()}`;
    consumed++;
  }
  return { statement: `${leading}${text.replace(/\s+/g, " ")}`, consumed };
}

/**
 * Parse static import statements, including ones spanning multiple lines.
 * Supports: default, named, namespace, mixed, side-effect imports.
 * Skips type-only imports and type specifiers in named imports.
 * Returns bindings in source order.
 */
export function parseImportBindings(code: string): ImportBinding[] {
  const bindings: ImportBinding[] = [];
  const lines = code.split("\n");

  let i = 0;
  while (i < lines.length) {
    const trimmedStart = lines[i].trim();

    if (!trimmedStart.startsWith("import ")) {
      i++;
      continue;
    }

    const { statement, consumed } = joinStatementLines(
      lines,
      i,
      isCompleteImportStatement,
    );
    i += consumed;

    const line = statement.trim();

    // Skip type-only imports: `import type { ... } from "..."`
    if (/^import\s+type\s+/.test(line)) continue;

    const specifierMatch = line.match(/["']([^"']+)["']\s*;?\s*$/);
    if (!specifierMatch) continue;

    const specifier = specifierMatch[1];

    if (line.includes(" from ")) {
      // Has "from" keyword: default, named, namespace, or mixed
      const fromIndex = line.indexOf(" from ");
      const bindingClause = line.substring(7, fromIndex).trim(); // Skip "import "

      if (bindingClause === "") {
        // Side-effect import: import "module"
        continue;
      }

      // Handle namespace import: import * as ns from "..."
      const namespaceMatch = bindingClause.match(/^\*\s+as\s+(\w+)$/);
      if (namespaceMatch) {
        bindings.push({
          local: namespaceMatch[1],
          imported: "*",
          specifier,
        });
        continue;
      }

      const parts: { default?: string; named: ImportBinding[] } = { named: [] };

      if (bindingClause.includes("{")) {
        const defaultMatch = bindingClause.match(/^(\w+)\s*,\s*\{/);
        if (defaultMatch) {
          parts.default = defaultMatch[1];
        }

        const namedMatch = bindingClause.match(/\{([^}]+)\}/);
        if (namedMatch) {
          parts.named = parseNamedImports(namedMatch[1], specifier);
        }
      } else {
        parts.default = bindingClause;
      }

      if (parts.default) {
        bindings.push({
          local: parts.default,
          imported: "default",
          specifier,
        });
      }

      bindings.push(...parts.named);
    }
  }

  return bindings;
}

/**
 * Parse named imports from the {...} clause.
 * Handles: `a`, `a as b`, `type A` (skip), `type A as B` (skip), `type A, b` (keep b).
 */
function parseNamedImports(
  namedClause: string,
  specifier: string,
): ImportBinding[] {
  const bindings: ImportBinding[] = [];

  const items = namedClause.split(",").map((s) => s.trim());

  for (const item of items) {
    if (item === "") continue;

    // Skip type specifiers: `type X`, `type X as Y`
    if (item.startsWith("type ")) continue;

    // Parse: `name` or `name as localName`
    const asMatch = item.match(/^(\w+)\s+as\s+(\w+)$/);
    if (asMatch) {
      bindings.push({
        local: asMatch[2],
        imported: asMatch[1],
        specifier,
      });
    } else {
      bindings.push({
        local: item,
        imported: item,
        specifier,
      });
    }
  }

  return bindings;
}
