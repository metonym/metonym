/** Cached Bun.Transpiler instances. Creating one per call dominated extract/generate. */

export type Loader = "ts" | "tsx" | "js" | "jsx";

const cache = new Map<Loader, Bun.Transpiler>();

export function loaderFromPath(file: string): Loader {
  if (file.endsWith(".ts")) return "ts";
  if (file.endsWith(".tsx")) return "tsx";
  if (file.endsWith(".jsx")) return "jsx";
  return "js";
}

export function getTranspiler(loader: Loader): Bun.Transpiler {
  let transpiler = cache.get(loader);
  if (!transpiler) {
    transpiler = new Bun.Transpiler({ loader });
    cache.set(loader, transpiler);
  }
  return transpiler;
}
