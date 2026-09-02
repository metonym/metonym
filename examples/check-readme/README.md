# Check your README in CI

Point `exports` at source so examples can import this package by name before
it is published. Then run `metonym check` in CI.

```json
{
  "name": "example-check-readme",
  "exports": { ".": "./src/index.ts" },
  "scripts": { "check": "metonym check" }
}
```

```console
metonym check
README.md
  ✓ add › example 1
```

## add

```ts
import { add } from "example-check-readme"

expect(add(2, 3)).toBe(5)
```
