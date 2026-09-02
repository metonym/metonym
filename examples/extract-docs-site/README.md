# Extract IR for a docs site

`metonym extract --format=json` emits the Documentation IR a static site can
pre-render. TypeScript is this package's dependency, not metonym's. With it
installed, analysis is deep and each example carries hover metadata.

TypeScript 7 (native Go) does not ship `createProgram` yet. Deep analysis
needs the compiler API, so this recipe installs the same typescript6 alias
the metonym repo uses (`npm:@typescript/typescript6`) until 7.1.

```json
{
  "devDependencies": {
    "typescript": "npm:@typescript/typescript6@^6.0.2"
  },
  "metonym": { "analysis": "deep" }
}
```

```console
metonym extract --format=json > ir.json
bun site/render.ts
```

## add

```ts
import { add } from "example-extract-docs-site"

expect(add(2, 3)).toBe(5)
```
