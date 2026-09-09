# JSON output schemas

Every JSON document metonym's CLI prints carries a top-level `tool: { name,
version }` and, except the Documentation IR, a `schema: "<kind>@1"` field —
a stable way for an agent (or a script) to identify what it's looking at
without guessing from shape alone.

**Stability promise:** additive changes (a new optional field) never bump
anything. A rename or removal of an existing field bumps that schema's `@N`
suffix; a rename or removal on the Documentation IR bumps `IR_VERSION`
instead (see `extract --format=json` below). Either way, old field names are
never repurposed for a new meaning under the same version.

## `run@1` — `check --reporter=json`

```jsonc
{
  "tool": { "name": "metonym", "version": "0.1.0" },
  "schema": "run@1",
  "results": [
    {
      "exampleId": "ex:README.md:30a8c12e",
      "title": "Quick start › example 1",
      "docFile": "README.md",
      "docLine": 6,
      "status": "passed",
      "durationMs": 1.17
    }
  ],
  "totals": {
    "total": 2, "passed": 2, "failed": 0, "pending": 0, "skipped": 0,
    "durationMs": 1.21, "cached": 0
  },
  "outDir": "/abs/path/.metonym/tests",
  "exitCode": 0
}
```

- `results[]` — one entry per example. `status` is `"passed" | "failed" |
  "pending" | "skipped"`. `docLine` is the 1-indexed line in `docFile` where
  the example's code begins, omitted when remapping failed. `fromCache` is
  `true` when a result was served from the result cache instead of executed
  (omitted otherwise). Failures add a `failure` object: `message`, optional
  `type`/`expected`/`received`/`stack`, `generated: { file, line?, column?
  }` (always present) and `doc: { file, line, column? }` (present only when
  remapping to the original doc succeeded).
- `totals` — counts across `results`, plus `durationMs` for the whole run
  and `cached` (how many results were served from cache).
- `outDir` — where the generated test files and artifacts live.
- `exitCode` — the underlying `bun test` exit code; `130` means the run was
  interrupted (Ctrl-C).
- `stderr` — child-process stderr, only present when `exitCode !== 0`,
  truncated to the last 8 KiB.
- `junitMissing` — `true` when the JUnit report couldn't be read (the run
  broke before producing results, as opposed to tests failing normally).

## `list@1` — `check --list --reporter=json`

```jsonc
{
  "tool": { "name": "metonym", "version": "0.1.0" },
  "schema": "list@1",
  "examples": [
    {
      "id": "ex:README.md:30a8c12e",
      "kind": "assertion",
      "language": "ts",
      "docFile": "README.md",
      "line": 6,
      "title": "Quick start › example 1"
    }
  ]
}
```

Selected examples, without generating or running anything. `kind` is
`"assertion" | "no-run" | "throws" | "pending" | "ignored"`. `group` is
present only on examples declared with a `group=` fence attribute.

## `coverage@1` — `coverage --reporter=json`

```jsonc
{
  "tool": { "name": "metonym", "version": "0.1.0" },
  "schema": "coverage@1",
  "symbols": { "total": 1, "documented": 1, "withExamples": 1, "exercised": 1 },
  "exercised": ["sym:src/index.ts:add"],
  "documents": { "total": 2, "withExamples": 2 },
  "examples": { "total": 2, "withTypeErrors": 0 },
  "undocumented": [],
  "documentedWithoutExamples": [],
  "examplesWithTypeErrors": [],
  "reexports": 0,
  "gates": { "pass": true, "failures": [] }
}
```

- `symbols` — exported-symbol counts: documented, has an example,
  "exercised" (referenced by an executable example). `reexports` are
  excluded from these totals.
- `exercised` — sorted symbol ids referenced by an executable example.
- `documents` — doc-file counts: total, has at least one example.
- `examples` — deep-analysis-only type-error counts; both fields are `0`
  without type-checked examples.
- `undocumented` / `documentedWithoutExamples` — `SymbolInfo[]` (from the
  IR) needing attention.
- `examplesWithTypeErrors` — `{ id, title, docFile, errorCount }[]`, deep
  analysis only, sorted by `(docFile, title)`.
- `gates` — present only with `--check`: `{ pass, failures: string[] }`
  against the `metonym.config`'s `coverage` gates.

## `impact@1` — `impact --format=json`

```jsonc
{
  "tool": { "name": "metonym", "version": "0.1.0" },
  "schema": "impact@1",
  "changedFiles": ["src/index.ts"],
  "traces": [
    {
      "exampleId": "ex:src/index.ts:30a8c12e",
      "docFile": "src/index.ts",
      "title": "add › example 1",
      "changedFile": "src/index.ts",
      "path": [],
      "reason": "doc-changed"
    }
  ],
  "affectedExamples": ["ex:src/index.ts:30a8c12e"],
  "affectedDocs": ["src/index.ts"],
  "typeErrorCounts": {}
}
```

- `changedFiles` — the input: files passed as arguments, or the files git
  reports as changed.
- `traces[]` — one entry per (example, changed file) impact edge.
  `reason` is `"imports" | "doc-changed" | "config-changed"`. `path` is the
  import chain from the example's entry file to the changed file
  (inclusive both ends), empty for `doc-changed`/`config-changed`.
- `affectedExamples` / `affectedDocs` — deduped, sorted ids/files.
- `typeErrorCounts` — `exampleId → error-severity diagnostic count`,
  deep-analysis only; examples without type errors are omitted.

## The Documentation IR — `extract --format=json`

Not wrapped in `schema`; it carries its own `irVersion` (currently `1`) and
`tool: { name, version }` directly on the `DocumentationSet`. A rename or
removal of an IR field bumps `IR_VERSION`, same rule as the `@N` schemas
above. See ["Docs as data"](../src/README.md#docs-as-data) for its shape.
