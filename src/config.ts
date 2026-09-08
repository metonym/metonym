import { resolve } from "node:path";
import { DEFAULT_CONFIG, type MetonymConfig } from "./ir/types.ts";

/**
 * Identity function for typing aid when defining config in code.
 * Enables TypeScript intellisense and validation without runtime overhead.
 *
 * @example
 * ```ts
 * import { defineConfig } from "metonym"
 *
 * const config = defineConfig({ analysis: "deep" })
 * expect(config.analysis).toBe("deep")
 * ```
 */
export function defineConfig(
  c: Partial<MetonymConfig>,
): Partial<MetonymConfig> {
  return c;
}

/**
 * Load metonym configuration, merging sources in priority order:
 * 1. DEFAULT_CONFIG (baseline)
 * 2. package.json "metonym" key (if exists)
 * 3. metonym.config.ts (or metonym.config.js, if .ts is absent) default export
 * 4. overrides parameter
 * 5. root field (always set to the root parameter)
 *
 * Arrays replace entirely (no concat). Validates that include/exclude/languages
 * are arrays if present; throws clear Error on validation failure. A missing
 * config file is fine; a broken one is not — syntax and runtime errors while
 * loading `metonym.config.ts`/`.js` propagate instead of being swallowed.
 */
export async function loadConfig(
  root: string,
  overrides?: Partial<MetonymConfig>,
): Promise<MetonymConfig> {
  const config: Partial<MetonymConfig> = {
    ...DEFAULT_CONFIG,
  };

  const packageJsonPath = resolve(root, "package.json");
  const packageJsonText = await Bun.file(packageJsonPath)
    .text()
    .catch(() => undefined);

  let packageJson: unknown;
  if (packageJsonText !== undefined) {
    try {
      packageJson = JSON.parse(packageJsonText);
    } catch (err) {
      throw new Error(
        `Invalid metonym config: package.json is not valid JSON (${errorMessage(err)})`,
        { cause: err },
      );
    }
  }

  const tsPath = resolve(root, "metonym.config.ts");
  const jsPath = resolve(root, "metonym.config.js");
  const configPath = (await Bun.file(tsPath).exists())
    ? tsPath
    : (await Bun.file(jsPath).exists())
      ? jsPath
      : undefined;

  let configFromFile: unknown;
  if (configPath) {
    const configName = configPath.endsWith(".js")
      ? "metonym.config.js"
      : "metonym.config.ts";
    try {
      const mod = (await import(`file://${configPath}`)) as {
        default?: unknown;
      };
      configFromFile = mod.default;
    } catch (err) {
      throw new Error(`Failed to load ${configName}: ${errorMessage(err)}`, {
        cause: err,
      });
    }
  }

  if (
    packageJson !== undefined &&
    typeof packageJson === "object" &&
    packageJson !== null &&
    "metonym" in packageJson
  ) {
    const metonymField = (packageJson as Record<string, unknown>).metonym;
    if (typeof metonymField !== "object" || metonymField === null) {
      throw new Error(
        `Invalid metonym config: "package.json#metonym" must be an object, got ${typeof metonymField}`,
      );
    }
    mergeConfig(config, metonymField as Partial<MetonymConfig>);
  }

  if (configFromFile !== undefined) {
    if (typeof configFromFile !== "object" || configFromFile === null) {
      throw new Error(
        `Invalid metonym config: metonym.config default export must be an object, got ${typeof configFromFile}`,
      );
    }
    mergeConfig(config, configFromFile as Partial<MetonymConfig>);
  }

  if (overrides) {
    mergeConfig(config, overrides);
  }

  validateConfig(config);

  const finalConfig: MetonymConfig = {
    include: config.include || DEFAULT_CONFIG.include,
    exclude: config.exclude || DEFAULT_CONFIG.exclude,
    outDir: config.outDir || DEFAULT_CONFIG.outDir,
    languages: config.languages || DEFAULT_CONFIG.languages,
    inject: config.inject !== undefined ? config.inject : DEFAULT_CONFIG.inject,
    jsxImportSource: config.jsxImportSource,
    analysis: config.analysis,
    coverage: config.coverage,
    root,
  };

  return finalConfig;
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Merge a source config object into the target config.
 * Arrays replace entirely (no concat).
 */
function mergeConfig(
  target: Partial<MetonymConfig>,
  source: Partial<MetonymConfig>,
): void {
  for (const key of Object.keys(source) as Array<
    keyof Partial<MetonymConfig>
  >) {
    if (
      key === "include" ||
      key === "exclude" ||
      key === "outDir" ||
      key === "languages" ||
      key === "inject" ||
      key === "jsxImportSource" ||
      key === "analysis" ||
      key === "coverage" ||
      key === "root"
    ) {
      if (source[key] !== undefined) {
        Object.assign(target, { [key]: source[key] });
      }
    }
  }
}

/**
 * Validate config array fields are actually arrays if present.
 * Throws clear Error on validation failure.
 */
function validateConfig(config: Partial<MetonymConfig>): void {
  const arrayFields = ["include", "exclude", "languages"] as const;

  for (const field of arrayFields) {
    if (config[field] !== undefined) {
      if (!Array.isArray(config[field])) {
        throw new Error(
          `Invalid metonym config: "${field}" must be an array, got ${typeof config[field]}`,
        );
      }
    }
  }

  if (config.inject !== undefined) {
    if (typeof config.inject !== "boolean") {
      throw new Error(
        `Invalid metonym config: "inject" must be a boolean, got ${typeof config.inject}`,
      );
    }
  }

  if (
    config.jsxImportSource !== undefined &&
    typeof config.jsxImportSource !== "string"
  ) {
    throw new Error(
      `Invalid metonym config: "jsxImportSource" must be a string, got ${typeof config.jsxImportSource}`,
    );
  }

  if (
    config.analysis !== undefined &&
    config.analysis !== "auto" &&
    config.analysis !== "shallow" &&
    config.analysis !== "deep"
  ) {
    throw new Error(
      `Invalid metonym config: "analysis" must be "auto", "shallow", or "deep", got ${JSON.stringify(config.analysis)}`,
    );
  }

  if (config.outDir !== undefined) {
    if (typeof config.outDir !== "string") {
      throw new Error(
        `Invalid metonym config: "outDir" must be a string, got ${typeof config.outDir}`,
      );
    }
  }

  if (config.coverage !== undefined) {
    if (typeof config.coverage !== "object" || config.coverage === null) {
      throw new Error(
        `Invalid metonym config: "coverage" must be an object, got ${typeof config.coverage}`,
      );
    }

    const coverage = config.coverage as Record<string, unknown>;

    if (coverage.minDocumented !== undefined) {
      if (typeof coverage.minDocumented !== "number") {
        throw new Error(
          `Invalid metonym config: "coverage.minDocumented" must be a number, got ${typeof coverage.minDocumented}`,
        );
      }
      if (coverage.minDocumented < 0 || coverage.minDocumented > 100) {
        throw new Error(
          `Invalid metonym config: "coverage.minDocumented" must be between 0 and 100, got ${coverage.minDocumented}`,
        );
      }
    }

    if (coverage.minExamples !== undefined) {
      if (typeof coverage.minExamples !== "number") {
        throw new Error(
          `Invalid metonym config: "coverage.minExamples" must be a number, got ${typeof coverage.minExamples}`,
        );
      }
      if (coverage.minExamples < 0 || coverage.minExamples > 100) {
        throw new Error(
          `Invalid metonym config: "coverage.minExamples" must be between 0 and 100, got ${coverage.minExamples}`,
        );
      }
    }

    if (coverage.failOnUndocumented !== undefined) {
      if (typeof coverage.failOnUndocumented !== "boolean") {
        throw new Error(
          `Invalid metonym config: "coverage.failOnUndocumented" must be a boolean, got ${typeof coverage.failOnUndocumented}`,
        );
      }
    }

    if (coverage.failOnTypeErrors !== undefined) {
      if (typeof coverage.failOnTypeErrors !== "boolean") {
        throw new Error(
          `Invalid metonym config: "coverage.failOnTypeErrors" must be a boolean, got ${typeof coverage.failOnTypeErrors}`,
        );
      }
    }
  }
}
