# Benchmarks

[mitata](https://github.com/evanwashere/mitata) benches for the extract hot path and the scan → extract → generate pipeline, plus a one-off `check` timing that includes `run`.

- `parse.bench.ts` — in-memory `scanFences`, `extractMarkdown`, `extractJsdoc`, plus `extractSourceCpu` (shared-block JSDoc + comments), `scanSymbols`, and `scanDecls` across small/medium/large authored strings. No filesystem.
- `pipeline.bench.ts` — `scan`, `extract`, `assemble`, and `generate` against synthetic S (100 files) and M (2000 files) repos from `gen.ts`. Coarser than parse: real file I/O, so treat it as an end-to-end baseline rather than a tight microbenchmark. Prints a one-off phase breakdown (scan / extract / generate) and an extract subphase split (read / markdown / jsdoc / scanSymbols / scanDecls / comments / assemble). Does not execute examples.
- `check.bench.ts` — `scan` → `extractCached` → `generate` → `runCached`, matching CLI `check` (no `--full`). Cold vs warm cache on the same S/M fixtures. Examples must pass or the bench throws — failures are never cached, so a broken fixture makes "warm" a lie. Not mitata: M would loop `bun test` across thousands of files.

S-repo scan+extract+generate target: under 1000ms on a single run (see the pipeline phase breakdown, not mitata's per-iter average).

## Running

```sh
bun run bench           # parse, then pipeline (no check — check runs tests)
bun run bench:parse
bun run bench:pipeline
bun run bench:check     # S and M, cold then warm
bun bench/check.bench.ts S
```

## Notes

- Numbers are machine-relative, not absolute. Use them to compare before/after a change on the same machine, not across machines.
- `parse` does not mutate shared state between iterations. `pipeline` generates each synthetic repo once before `run()`, so results aren't skewed by fixture generation — only by the OS file cache.
- `check` generates into `bench/tmp/check-{S,M}` (not the pipeline dirs). Fixture `package.json` pins `analysis: "shallow"` so a parent `typescript` doesn't pull deep analysis into the numbers.
- When investigating a regression, run the relevant `bench:*` script before and after your change and compare `avg`/`p75` (parse/pipeline) or the cold/warm phase rows (check).
