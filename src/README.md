# metonym

**Executable documentation for Bun.** metonym extracts the code examples in
your README, Markdown docs, and JSDoc comments, turns them into real
`bun:test` files, runs them, and reports failures against the original
documentation line.

> If the README says it works, CI can prove it works.

This README is verified by metonym itself. Every `ts` code block below is
extracted and executed in CI.

- Fail CI on the README line that broke.
- Gate coverage on exports that examples actually call.
- Trace a source change to the docs it invalidates.
- Zero runtime dependencies. Bun ≥ 1.4 only.
- Mark APIs that do not exist yet `pending`. They report. They do not fail CI.

Copy-paste recipes for adding metonym to a package live in
[examples/](../examples/).

## Install

```console
bun add -d metonym
bunx metonym check
```

## Check

`metonym check` (alias `test`) extracts examples, runs them as `bun:test`, and
remaps failures to the documentation line.

```console
metonym check
README.md
  ✓ Quick start › example 1        (12ms)
  ✗ Broken claim › example 1       README.md:18
  ○ Future API › example 1         pending

Documentation example failed

  README.md:18
  id: ex:README.md:44a5c1b2

  > 18 | expect(result).toBe(6)
                            ^
  Expected: 6
  Received: 5

4 examples · 2 passed · 1 failed · 1 pending
```

See [`docs/github-actions.md`](../docs/github-actions.md) for a copy-pasteable
GitHub Actions workflow, including caching and `--changed` on pull requests.

## Authoring

`ts` / `tsx` / `js` / `jsx` fenced blocks in your docs are executable by
default. The aliases `typescript` and `javascript` are also accepted, and
the language token is case-insensitive. Attributes on the fence line opt
out or change semantics:

| Attribute | Meaning |
| --- | --- |
| *(none)* | Runs as a test; `expect` is auto-imported if not imported, unless `inject: false` |
| `no-run` | Transpile-checked at generation time, never executed |
| `throws` | Passes only if the body throws |
| `pending` | Documented-but-unimplemented API; reported, never fails CI |
| `ignore` | Skipped entirely |
| `group=name` | Blocks sharing a group run in one scope, in order |

Every example body is wrapped in an `async` function, so top-level `await`
just works. Static imports are rewritten in place to dynamic imports, and
line numbers are preserved 1:1, which is how failures map back to your docs.

**MDX** (`docs/**/*.mdx`) works out of the box: fenced examples extract
exactly like markdown; top-level `import`/`export` statements, JSX blocks,
and `{/* comments */}` are inert.

**TSX/JSX examples** (```` ```tsx ````) generate `.test.tsx` files. To run
JSX, set `"metonym": { "jsxImportSource": "<pkg>" }`. The import source
must export both `./jsx-runtime` **and** `./jsx-dev-runtime` (Bun's test
transpile uses `jsxDEV`). A package can self-provide its runtime via its
own `exports` map, keeping everything zero-dependency.

## README-driven development

Give your package an `exports` entry pointing at source:

```json
{ "name": "your-pkg", "exports": { ".": "./src/index.ts" } }
```

Your README can then import `"your-pkg"` by name *before it is ever
published*. Bun resolves the self-reference. Describe APIs that don't
exist yet with `pending` fences; `metonym check` reports them separately
until you implement them and drop the attribute:

```ts pending
import { toSvg } from "metonym"
```

## Coverage

`metonym coverage` reports which exports lack documentation or executable
examples, with declaration locations. Percentages count exports that have
examples. An "exercised by examples" count is which APIs fences actually
call. Barrel re-exports are excluded from the totals.

A README example that imports and calls an export documents and exercises
it too — you don't need JSDoc `@example` blocks just to score coverage.

`metonym coverage --check` enforces thresholds from config and exits
nonzero for CI. All gates are optional and independent — see
[coverage in the CLI section](#coverage) for the full list, including
`failOnTypeErrors` for examples that fail deep-analysis type-checking:

```json
{ "metonym": { "coverage": { "minDocumented": 80, "failOnUndocumented": true } } }
```

Or the same shape in `metonym.config.ts`:

```ts
import { defineConfig } from "metonym"

const config = defineConfig({
  analysis: "deep",
  coverage: { minDocumented: 80, failOnUndocumented: true, failOnTypeErrors: true },
})
expect(config.analysis).toBe("deep")
expect(config.coverage?.minDocumented).toBe(80)
expect(config.coverage?.failOnUndocumented).toBe(true)
expect(config.coverage?.failOnTypeErrors).toBe(true)
```

## Impact

`metonym impact [files…]` traces which examples a change affects: changed
file, import chain, examples, doc files. Output is a text tree, JSON,
Mermaid, or DOT. Changed files come from git when no arguments are passed.

```console
metonym impact src/parse/info.ts
src/parse/info.ts changed
  → src/index.ts → src/parse/info.ts → 5 examples
      README.md › Library › example 1
      …
5 example(s) affected across 1 documentation file(s)
```

`metonym check --changed[=<ref>]` runs only examples affected by your git
changes, traced through each example's import closure. It falls back to
running everything when in doubt. Unchanged examples whose import closure
hasn't changed are served from `.metonym/cache/` instead of re-executed.

A cached result is invalidated by any of: the example's own body, the
content of every file in its local import closure, the project's
dependency lockfile (or `package.json`), the metonym/Bun tool version,
and (for `tsx`/`jsx` examples) `jsxImportSource`. Examples with inputs
the cache can't see, fixtures read from disk, environment variables,
network calls, should run with `--full` in CI so they're never served
stale.

## Docs as data

`metonym extract --format=json` emits a feed a static docs site can
pre-render as an API reference. No site generator is included, by design.

Every JSON command (`check --reporter=json`, `check --list`, `coverage`,
`impact`) is stamped with a `tool` identity and a versioned `schema`, so an
agent can identify what it's looking at without guessing from shape alone.
See [`docs/json.md`](../docs/json.md) for the field-by-field reference and
the stability promise.

With deep analysis on, the IR carries per-symbol JSDoc prose and tags,
type signatures, and per-example hover metadata. For every identifier in
every example, a `{ start, length, line, column, info, docs?, symbol? }`
record whose offsets are byte-exact against the authored snippet
(`example.code`). `info` is editor-style quick-info text. `symbol` links
the token to its API entry. Render them as static tooltip spans. Nothing
runs in the browser.

```jsonc
// symbols[]:  { "signature": "(project: Project): Promise<DocumentationSet>",
//               "description": "…", "tags": { "param": ["…"] } }
// examples[]: { "hovers": [{ "start": 9, "length": 15,
//               "info": "function extractMarkdown(text: string, …): ExtractMarkdownResult",
//               "symbol": "sym:src/parse/markdown.ts:extractMarkdown" }] }
```

## Agents

`metonym mcp` runs an [MCP](https://modelcontextprotocol.io) server over
stdio, so an agent gets `list`/`extract`/`impact`/`coverage` as tools
instead of shelling out to the CLI. Each tool returns the same
[JSON](../docs/json.md) the CLI prints, wrapped in MCP's `content: [{
type: "text", text }]`. `check` (`metonym_check`) executes documentation
code, so it's only registered when the server is started with
`--allow-run`; calling it without the flag returns an error result
explaining why.

```json
{ "command": "bunx", "args": ["metonym", "mcp"] }
```

## Deep analysis (optional)

If `typescript` is installed in your project, metonym uses it for symbol
analysis (`--analysis=auto`, the default). Identifiers in examples resolve
semantically: shadowed or string-only mentions don't count, imported-but-unused
bindings don't count. Re-export chains and `export *` are fully enumerated,
and a symbol-to-symbol call graph is added to the IR (`calls` edges in
`metonym graph`). Without typescript, the zero-dependency scanners are used.
Force either mode with `--analysis=deep|shallow` or
`"metonym": { "analysis": "…" }`. TypeScript is never a metonym dependency.
It is loaded from *your* project only.

`metonym check` runs examples, and nothing it reports depends on deep
analysis, so under `auto` it skips the TypeScript pass entirely (loading the
compiler and parsing typings is most of a cold run). `extract`, `build`,
`coverage`, `graph`, and `impact` use it, as does `check --changed` and
`check` with `analysis: "deep"` set explicitly.

## Library

Extract is pure. `run` is the only effectful verb. Coverage and graphs query
the same `DocumentationSet`.

Extract examples from any Markdown, no execution, precise locations:

```ts
import { extractMarkdown } from "metonym"

const markdown = "# Hi\n\n```ts\nconst x = 1\n```\n"
const { document, examples } = extractMarkdown(markdown, { file: "virtual.md" })

expect(document.id).toBe("doc:virtual.md")
expect(examples.length).toBe(1)
expect(examples[0].code).toBe("const x = 1\n")
expect(examples[0].source.start.line).toBe(4)
```

JSDoc `@example` blocks extract the same way, with the export as `owner`:

```ts
import { extractJsdoc } from "metonym"

const source = [
  "/**",
  " * Adds two numbers.",
  " * @example",
  " * ```ts",
  " * expect(add(2, 3)).toBe(5)",
  " * ```",
  " */",
  "export function add(a: number, b: number): number {",
  "  return a + b",
  "}",
].join("\n")
const { examples } = extractJsdoc(source, { file: "add.ts" })

expect(examples.length).toBe(1)
expect(examples[0].owner).toBe("sym:add.ts:add")
expect(examples[0].code).toContain("expect(add(2, 3)).toBe(5)")
```

Example IDs are content-hashed and stable. Editing one example never
invalidates another, and identical bodies disambiguate by document order:

```ts
import { createExampleIdAllocator } from "metonym"

const alloc = createExampleIdAllocator("README.md")
const first = alloc("expect(1).toBe(1)")
const second = alloc("expect(1).toBe(1)")

expect(first.startsWith("ex:README.md:")).toBe(true)
expect(second).toBe(`${first}~1`)
```

Fence attributes control example semantics:

```ts
import { parseInfoString } from "metonym"

const info = parseInfoString("ts throws group=setup")
expect(info.lang).toBe("ts")
expect(info.kind).toBe("throws")
expect(info.group).toBe("setup")
```

`assembleDocumentationSet` turns those parts into a `DocumentationSet`.
`generate` emits `bun:test` files from it, still no execution:

```ts
import { assembleDocumentationSet, extractMarkdown, generate } from "metonym"

const markdown = "# Hi\n\n```ts\nconst x = 1\n```\n"
const { document, examples } = extractMarkdown(markdown, { file: "virtual.md" })
const docs = assembleDocumentationSet(".", [
  { file: "virtual.md", document, examples, symbols: [] },
])
const tests = generate(docs)

expect(tests[0].path).toBe("virtual.md.test.ts")
expect(tests[0].code).toContain("const x = 1")
```

The same `DocumentationSet` serializes as a Mermaid flowchart
(`metonym graph --format=mermaid`):

```ts
import { assembleDocumentationSet, extractMarkdown, toMermaid } from "metonym"

const markdown = "# Hi\n\n```ts\nconst x = 1\n```\n"
const { document, examples } = extractMarkdown(markdown, { file: "virtual.md" })
const docs = assembleDocumentationSet(".", [
  { file: "virtual.md", document, examples, symbols: [] },
])
const mermaid = toMermaid(docs)

expect(mermaid.startsWith("flowchart LR")).toBe(true)
expect(mermaid).toContain("virtual.md")
```

Coverage is a query over that set. JSDoc examples create `owns` / `documents`
edges, which is what the percentages count:

```ts
import { assembleDocumentationSet, checkCoverage, coverage, extractJsdoc, scanSymbols } from "metonym"

const source = [
  "/**",
  " * Adds two numbers.",
  " * @example",
  " * ```ts",
  " * expect(add(2, 3)).toBe(5)",
  " * ```",
  " */",
  "export function add(a: number, b: number): number {",
  "  return a + b",
  "}",
].join("\n")
const { document, examples } = extractJsdoc(source, { file: "add.ts" })
const symbols = scanSymbols("add.ts", source)
const docs = assembleDocumentationSet(".", [
  { file: "add.ts", document, examples, symbols },
])

expect(coverage(docs).symbols.withExamples).toBe(1)
expect(checkCoverage(docs, { minDocumented: 80 }).pass).toBe(true)
```

The full pipeline is four verbs. `extract` never executes anything. `run`
is the only effectful step. Pass `generate`'s output into `run`. Point
`scan` at a package, not this repo, or `metonym check` re-enters itself.
See [examples/programmatic-pipeline](../examples/programmatic-pipeline/):

```ts no-run
import { extract, generate, run, scan } from "metonym"

const project = await scan({ root: "." })
const docs = await extract(project)
const generated = generate(docs)
const result = await run(docs, { generated })
console.log(result.totals)
```

## CLI

```console
metonym --help
metonym v0.1.0 — executable documentation for Bun

Usage:
  metonym check [paths…]              verify documentation examples
  metonym test  [paths…]              alias of check
  metonym extract [--format=json]     emit the Documentation IR
  metonym extract --format=tests      write generated bun:test files
  metonym build --format=<fmt>        render docs (markdown|html|json|jsonl)
  metonym graph --format=<fmt>        emit the doc/code graph (json|mermaid|dot)
  metonym coverage [--check]          coverage report (--check: enforce config gates)
  metonym impact [files…]             trace which examples a change affects
                                      (files from args or git; --format=text|json|mermaid|dot)
```

Also `metonym help` / `metonym version` as their own commands.

### check / test

`check` (alias `test`) extracts examples, runs them as `bun:test`, and remaps
failures to the documentation line. `[paths…]` restricts extraction to
files/directories under those paths (matched against repo-relative doc/source
paths, not glob patterns).

| Flag | Effect |
| --- | --- |
| `--filter=<substring>` | Only run examples whose title contains the substring |
| `--only=<id\|file:line>` | Only run these examples: a full or prefix example id (`ex:README.md:44a5`), or `<docFile>:<startLine>` (`README.md:18`). Repeatable, or comma-separated. Errors if an entry matches nothing. |
| `--list` | Print the selected examples (after `--filter`/`--only`/`--changed`) and exit; never generates or runs anything |
| `--failed` | Only run examples that failed (or never ran) in the last recorded `check`. Errors if no previous run is recorded. |
| `--reporter=pretty\|json\|github\|junit` | Output format; default `pretty`. With `--list`, `json` prints `{ tool, examples: [{ id, kind, language, docFile, line, title, group? }] }` instead of tab-separated lines. `github` is auto-selected when `GITHUB_ACTIONS=true` (pass `--reporter=pretty` to opt out) and prints [workflow-command](https://docs.github.com/en/actions/using-workflows/workflow-commands-for-github-actions) annotations to stdout in addition to the pretty report. `junit` writes a JUnit XML report to stdout, remapped to documentation file/line, for any CI that consumes JUnit |
| `--changed[=<ref>]` | Only examples affected by git changes since `<ref>` (default: working tree vs `HEAD`), traced through each example's import closure. `<ref>` is compared from its merge-base with `HEAD` (three-dot semantics). Falls back to running everything when the trace is ambiguous. |
| `--timeout=<ms>` | Per-test timeout, forwarded to `bun test --timeout` |
| `--bail[=<n>]` | Stop after `n` failures (default 1), forwarded to `bun test --bail` |
| `--watch` | Re-run on file changes; runs until interrupted (ctrl-c exits cleanly) |
| `--full` | Bypass the result cache, execute every example |
| `--workspaces` | Run `check` in every `package.json#workspaces` package (see [Monorepos](#monorepos)). Not compatible with `--watch`. |

Exit codes: `0` all passed, `1` one or more examples failed (or the run
didn't complete cleanly), `2` a usage error (unknown flag, invalid flag
value, or path arguments that match no files).

### Monorepos

`check --workspaces` discovers packages from the root `package.json#workspaces`
globs (array or `{ packages: [...] }` form) and runs `check` in each one,
printing a `<package>` header before each package's report. `--filter`,
`--only`, `--changed`, `--analysis`, `--no-config`, `--timeout`, and `--bail`
are forwarded to every package; positional paths only apply to the package(s)
they're rooted under. `--reporter=json` prints one merged document
(`{ tool, packages: [{ package, ...RunResult }], totals }`) instead of one
document per package. A package with no examples prints `<package>: no
examples` and doesn't affect the exit code; the overall exit code is `1` if
any package fails or breaks. Each package keeps its own result cache under
its own `.metonym/` — a monorepo CI cache should key on `**/.metonym`, not
just the root's (see [`docs/github-actions.md`](../docs/github-actions.md)).

### extract

Emits the `DocumentationSet` IR, or writes the generated `bun:test` files it
would run.

| `--format=` | Output |
| --- | --- |
| `json` (default) | The full IR as one JSON object to stdout |
| `jsonl` | One example per line (NDJSON) |
| `tests` | Writes `.test.ts`/`.test.tsx` files + sidecar maps to `--out-dir`; prints each path written |

### build

Renders docs from the IR. No execution unless `--run` is passed.

| Flag | Effect |
| --- | --- |
| `--format=markdown\|html\|json\|jsonl` | Renderer; default `markdown` |
| `--run` | Execute examples first and annotate rendered output with pass/fail/pending status |
| `--out-dir=<dir>` | Rendered file output directory; default `.metonym/build` |

### graph

Emits the doc/code graph — documents, examples, symbols, and the
`contains`/`documents`/`owns`/`imports`/`references`/`calls`/`generates`
relations between them.

`--format=json\|mermaid\|dot`, default `json`.

### coverage

Reports which exports lack documentation or executable examples, with
declaration locations. Percentages count exports that have examples. An
"exercised by examples" count is which APIs fences actually call — a
README example that imports and calls an export documents and exercises
it, no JSDoc `@example` required. Barrel re-exports are excluded from the
totals. With deep analysis, examples that fail to type-check are listed
separately — see [Deep analysis](#deep-analysis-optional).

`--check` enforces thresholds from `"metonym": { "coverage": { … } }` (or
the `coverage` field of `metonym.config.ts`) and exits `1` if any gate
fails, `0` otherwise:

| Gate | Meaning |
| --- | --- |
| `minDocumented` | Minimum % of exports with documentation (JSDoc, or referenced by any example) |
| `minExamples` | Minimum % of exports with an executable (non-`no-run`) example |
| `minExercised` | Minimum % of exports referenced by an executable example |
| `failOnUndocumented` | Fail if any export has zero documentation |
| `failOnTypeErrors` | Fail if any example has a type error (deep analysis only) |

`--reporter=json` emits the report (including the `exercised` symbol id
array) as JSON instead of the text summary. With `--check`, the JSON also
carries `gates: { pass, failures }`.

### impact

Traces which examples a change affects: changed file, import chain,
examples, doc files. `[files…]` are the changed files; when omitted, they
come from `git` (uncommitted + `--since=<ref>` if given — if the working
tree isn't a git repo, this errors and expects explicit paths). `<ref>` is
compared from its merge-base with `HEAD` (three-dot semantics).

`--format=text\|json\|mermaid\|dot`, default `text`. With deep analysis,
affected examples that currently fail to type-check are marked inline
(`⚠ N type error(s)`) in the text and `json` output (`typeErrorCounts`).

### mcp

Runs an [MCP](https://modelcontextprotocol.io) server over stdio, exposing
`list`/`extract`/`impact`/`coverage` (and, with `--allow-run`, `check`) as
tools for an agent. See ["Agents"](#agents) below.

### Global flags

These apply across commands wherever they're relevant:

| Flag | Effect |
| --- | --- |
| `--root=<dir>` | Project root; default cwd |
| `--out-dir=<dir>` | Overrides the generated-tests output directory, used by `check`, `extract --format=tests`, and `build --run`'s test execution. For `build`'s own rendered-file directory, see `--out-dir` under [build](#build) — the two are independent, so `build --run --out-dir=X` never lets stale-test pruning touch the docs `build` just rendered into `X` |
| `--analysis=auto\|shallow\|deep` | Symbol analysis depth; `deep` requires `typescript` resolvable from the project root |
| `--full` | Bypass caches, run/analyze everything from scratch |
| `--no-config` | Ignore `metonym.config.ts` (`package.json#metonym` still applies) |
| `--no-color` | Disable colored output. `NO_COLOR` (set) also disables it; `FORCE_COLOR` (set, not `0`) enables it even when stderr isn't a TTY; `--no-color` wins over both |
| `--help`, `--version` | Print usage / version and exit `0`, from any position |

Deleting `.metonym/` is always safe.

## Security

**Executable documentation is code execution.** Examples run with the full
permissions of the invoking Bun process, the same trust level as `bun test`
in that repository. There is no sandbox. `metonym extract` never executes
example code; only `check`/`test` do.

That is the right default for your own repo. Treat fenced `ts`/`js` like
any other test file.

Loading `metonym.config.ts` is also code execution: it is `import()`-ed and
runs with the same trust as the examples, regardless of which command you
run. On a tree you have not read, run `metonym extract --no-config`
(`package.json#metonym` still applies) — after that, nothing metonym does
executes project code.

If the tree is untrusted (a clone you have not read, a service that runs
other people's docs), isolate the process, or run only `metonym extract`.
`node:vm` is not a sandbox and cannot run these examples.

Docker works locally. Install inside the container rather than mounting a
host `node_modules`. `--network=none` is the useful default; drop it if
examples need the network. The `docker` group is root-equivalent, so this
isolates the examples, not a hostile Docker client.

```console
docker run --rm --network=none -v "$PWD":/src -w /src oven/bun:1 \
    sh -c "bun install && bunx metonym check"
```

macOS `sandbox-exec` and Linux `bwrap` do the same job without a daemon.
They are not portable, and a tight profile will break Bun, which needs to
read its own install and caches.

GitHub-hosted `pull_request` jobs already run in a VM, and fork PRs do not
get secrets by default. If you add secrets or switch to
`pull_request_target`, treat `metonym check` like `bun test`: run it
without those secrets, or in a separate job.

## Status

0.1.0. Markdown, MDX, and JSDoc `@example` extraction, `bun:test` execution
with doc-line remapping, coverage gates, impact, `--changed`, and optional
TypeScript deep analysis. See the sections above.
