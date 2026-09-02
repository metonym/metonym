# Programmatic pipeline

When the CLI is not enough, drive metonym from a script. `extract` never
executes example code; `run` is the only effectful step. Pass `generate`'s
output into `run` so the tests actually exist on disk.

Copy `pipeline.ts` into your repo and point `scan` at your package root.

## add

```ts
import { add } from "example-pipeline"

expect(add(2, 3)).toBe(5)
```
