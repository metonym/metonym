/**
 * TypeScript analysis mode resolution.
 * Determines whether to use the shallow scanner or the deep TS compiler.
 */

type AnalysisMode = "deep" | "shallow";

export interface AnalysisModeResult {
  mode: AnalysisMode;
  tsPath?: string;
}

/**
 * Resolve the analysis mode based on configuration and TypeScript availability.
 *
 * - "shallow" → always shallow (zero-dep)
 * - "deep" → require typescript to be resolvable; throw if not found
 * - "auto"/undefined → try to resolve typescript; if found use deep with tsPath, else shallow
 */
export function resolveAnalysisMode(
  root: string,
  analysis?: "auto" | "shallow" | "deep",
): AnalysisModeResult {
  if (analysis === "shallow") {
    return { mode: "shallow" };
  }

  if (analysis === "deep") {
    try {
      const tsPath = Bun.resolveSync("typescript", root);
      return { mode: "deep", tsPath };
    } catch {
      throw new Error(
        'analysis "deep" requires typescript to be installed in the project',
      );
    }
  }

  try {
    const tsPath = Bun.resolveSync("typescript", root);
    return { mode: "deep", tsPath };
  } catch {
    return { mode: "shallow" };
  }
}
