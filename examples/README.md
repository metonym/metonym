# Examples

Each folder is a tiny package you can copy. Recipes depend on the built
metonym artifact (`"metonym": "file:../../package"`), so run `bun run build`
before installing them. Root `bun ci` does not install these.

## Recipes

- [check-readme](check-readme/) — `metonym check` on README examples that import the package by name
- [coverage-gates](coverage-gates/) — `metonym coverage --check` with thresholds in `package.json`
- [extract-docs-site](extract-docs-site/) — `metonym extract --format=json` as a docs-site feed, with hover metadata from this package's own `typescript` (typescript6 alias; TS 7 has no compiler API yet)
- [programmatic-pipeline](programmatic-pipeline/) — `scan` → `extract` → `generate` → `run` without the CLI
- [jsx-components](jsx-components/) — TSX examples with a self-provided `jsx-runtime` and `jsx-dev-runtime`

## Run them

```console
bun run build
bun run examples
```

## Adding a recipe

1. Create `examples/<job>/` with `package.json`, `README.md`, and `src/`.
2. Depend on `"metonym": "file:../../package"`.
3. Add a CI script named after the CLI verb (`check`, `coverage`, or
   `extract`) whose value is the command you would run. The harness fails
   if none of those scripts is present.
4. Keep the subject library tiny. The recipe is the metonym wiring, not the library.

The harness discovers every `examples/*/package.json` in sorted order, runs
`bun install` then `bun run <check|coverage|extract>` in each, and reports
every failure rather than stopping at the first.
