/**
 * Static import statement parser for single-line imports.
 * Extracts import bindings (local name, imported name, module specifier).
 */

export interface ImportBinding {
  local: string; // name bound in local scope
  imported: string; // exported name from module; "default" for defaults, "*" for namespace
  specifier: string; // module specifier (unquoted)
}

/**
 * Parse complete single-line static import statements.
 * Supports: default, named, namespace, mixed, side-effect imports.
 * Skips type-only imports and type specifiers in named imports.
 * Multi-line imports are not goal and will be skipped.
 * Returns bindings in source order.
 */
export function parseImportBindings(code: string): ImportBinding[] {
  const bindings: ImportBinding[] = [];
  const lines = code.split("\n");

  for (const line of lines) {
    const trimmed = line.trim();

    if (!trimmed.startsWith("import ")) continue;

    // Skip type-only imports: `import type { ... } from "..."`
    if (/^\s*import\s+type\s+/.test(line)) continue;

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
