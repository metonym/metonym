# TSX examples with a self-provided JSX runtime

Bun's test transpile uses `jsxDEV`, so a custom `jsxImportSource` must export
both `./jsx-runtime` and `./jsx-dev-runtime`. This package provides both via
its `exports` map.

```json
{
  "name": "example-jsx",
  "exports": {
    ".": "./src/index.ts",
    "./jsx-runtime": "./src/jsx-runtime.ts",
    "./jsx-dev-runtime": "./src/jsx-dev-runtime.ts"
  },
  "metonym": { "jsxImportSource": "example-jsx" }
}
```

```console
metonym check
```

## tagOf

```tsx
import { tagOf } from "example-jsx"

const el = <div title="hi">x</div>
expect(tagOf(el)).toBe("div")
```
