export { defineConfig } from "./config";
export { generate } from "./emit/generate";
export {
  assembleDocumentationSet,
  extract,
} from "./extract";
export { toMermaid } from "./graph/emit";
export { checkCoverage, coverage } from "./graph/queries";
export { createExampleIdAllocator } from "./ir/ids";
export * from "./ir/types";
export { parseInfoString } from "./parse/info";
export { extractJsdoc } from "./parse/jsdoc";
export { extractMarkdown } from "./parse/markdown";
export { scanSymbols } from "./parse/symbols";
export { run } from "./run/run";
export { scan } from "./scan/scan";
