# Coverage gates in CI

Set thresholds under `"metonym": { "coverage": … }` in `package.json`, then
run `metonym coverage --check`. A failing gate exits nonzero.

Coverage counts a symbol as documented when it has a JSDoc `@example` (the
example is owned by that export). A prose-only comment is not enough.

```json
{
  "metonym": {
    "coverage": { "minDocumented": 80, "minExamples": 50 }
  }
}
```

```console
metonym coverage --check
coverage gates passed
```

A project that misses the threshold looks like this (this recipe is configured
to pass, so this is not what `bun run coverage` executes):

```console
metonym coverage --check
coverage gate failed:
  documented 50% < required 80%
```

## add

```ts
import { add } from "example-coverage-gates"

expect(add(2, 3)).toBe(5)
```

## multiply

```ts
import { multiply } from "example-coverage-gates"

expect(multiply(3, 4)).toBe(12)
```

## divide (type-checked, never executed)

`no-run` examples never execute, so a runtime test suite can't catch a bug in
one. With `typescript` installed, `metonym coverage`/`metonym check` deep
analysis type-checks every example — including `no-run` ones — against the
real `divide(a: number, b: number)` signature. This example is deliberately
broken to show that check catching a type error a test run never would:

```ts no-run
import { divide } from "example-coverage-gates"

const result = divide(10, "2")
```

```console
metonym coverage
symbols     3 total · 3 documented · 3 with examples · 3 exercised by examples
documents   2 total · 2 with examples

examples with type errors:
  README.md › divide (type-checked, never executed) › example 1 (1)
```

Enable `"coverage": { "failOnTypeErrors": true }` in `package.json` to make
`metonym coverage --check` exit nonzero on this instead of just reporting it
(left off here so this recipe still passes in CI).
