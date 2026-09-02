import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { DEFAULT_CONFIG, type MetonymConfig, scan } from "metonym";
import { loadConfig } from "../src/config";

let testFixtureDir: string;

beforeEach(() => {
  testFixtureDir = mkdtempSync(resolve(tmpdir(), "metonym-test-"));
});

afterEach(() => {
  if (testFixtureDir) {
    rmSync(testFixtureDir, { recursive: true, force: true });
  }
});

describe("scan", () => {
  test("finds README.md, docs md files, and src files with default config", async () => {
    writeFileSync(resolve(testFixtureDir, "README.md"), "# Example\n");
    mkdirSync(resolve(testFixtureDir, "docs"), { recursive: true });
    writeFileSync(resolve(testFixtureDir, "docs/guide.md"), "# Guide\n");
    mkdirSync(resolve(testFixtureDir, "docs/archive"), { recursive: true });
    writeFileSync(resolve(testFixtureDir, "docs/archive/old.md"), "# Old\n");
    mkdirSync(resolve(testFixtureDir, "src"), { recursive: true });
    writeFileSync(
      resolve(testFixtureDir, "src/a.ts"),
      "export function a() {}\n",
    );
    writeFileSync(
      resolve(testFixtureDir, "src/b.js"),
      "export function b() {}\n",
    );
    mkdirSync(resolve(testFixtureDir, "node_modules/x"), { recursive: true });
    writeFileSync(resolve(testFixtureDir, "node_modules/x/y.md"), "# Module\n");
    mkdirSync(resolve(testFixtureDir, ".metonym/tests"), { recursive: true });
    writeFileSync(resolve(testFixtureDir, ".metonym/tests/z.md"), "# Test\n");

    const project = await scan({ root: testFixtureDir });

    expect(project.docFiles).toContain("README.md");
    expect(project.docFiles).toContain("docs/guide.md");
    expect(project.docFiles).toContain("docs/archive/old.md");
    expect(project.docFiles).not.toContain("node_modules/x/y.md");
    expect(project.docFiles).not.toContain(".metonym/tests/z.md");

    expect(project.sourceFiles).toContain("src/a.ts");
    expect(project.sourceFiles).toContain("src/b.js");

    expect(project.docFiles).toEqual(project.docFiles.sort());
    expect(project.sourceFiles).toEqual(project.sourceFiles.sort());

    expect(project.root).toBe(testFixtureDir);

    expect(project.config.root).toBe(testFixtureDir);
  });

  test("excludes files matching exclude patterns", async () => {
    writeFileSync(resolve(testFixtureDir, "README.md"), "# Example\n");
    mkdirSync(resolve(testFixtureDir, "docs"), { recursive: true });
    writeFileSync(resolve(testFixtureDir, "docs/guide.md"), "# Guide\n");
    mkdirSync(resolve(testFixtureDir, "docs/archive"), { recursive: true });
    writeFileSync(resolve(testFixtureDir, "docs/archive/old.md"), "# Old\n");

    const project = await scan({
      root: testFixtureDir,
      config: {
        exclude: [
          "**/node_modules/**",
          "**/.git/**",
          "**/.metonym/**",
          "docs/archive/**",
        ],
      },
    });

    expect(project.docFiles).toContain("README.md");
    expect(project.docFiles).toContain("docs/guide.md");
    expect(project.docFiles).not.toContain("docs/archive/old.md");
  });

  test("loads config from package.json metonym key", async () => {
    const packageJsonPath = resolve(testFixtureDir, "package.json");
    writeFileSync(
      packageJsonPath,
      JSON.stringify({
        name: "test-package",
        metonym: {
          outDir: "custom-out",
        },
      }),
    );

    const config = await loadConfig(testFixtureDir);

    expect(config.outDir).toBe("custom-out");
    expect(config.include).toEqual(DEFAULT_CONFIG.include);
  });

  test("loads config from metonym.config.ts with priority over package.json", async () => {
    const packageJsonPath = resolve(testFixtureDir, "package.json");
    writeFileSync(
      packageJsonPath,
      JSON.stringify({
        name: "test-package",
        metonym: {
          outDir: "from-package",
          languages: ["js"],
        },
      }),
    );

    const configPath = resolve(testFixtureDir, "metonym.config.ts");
    writeFileSync(
      configPath,
      `export default {
  languages: ["ts"],
  outDir: "from-config",
};\n`,
    );

    const config = await loadConfig(testFixtureDir);

    expect(config.outDir).toBe("from-config");
    expect(config.languages).toEqual(["ts"]);
  });

  test("merges overrides on top of loaded config", async () => {
    const packageJsonPath = resolve(testFixtureDir, "package.json");
    writeFileSync(
      packageJsonPath,
      JSON.stringify({
        name: "test-package",
        metonym: {
          outDir: "from-package",
        },
      }),
    );

    const config = await loadConfig(testFixtureDir, {
      outDir: "from-overrides",
    });

    expect(config.outDir).toBe("from-overrides");
  });

  test("throws validation error on non-array include", async () => {
    const packageJsonPath = resolve(testFixtureDir, "package.json");
    writeFileSync(
      packageJsonPath,
      JSON.stringify({
        name: "test-package",
        metonym: {
          include: "nope",
        },
      }),
    );

    try {
      await loadConfig(testFixtureDir);
      expect.unreachable("should have thrown");
    } catch (error) {
      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).toContain("include");
      expect((error as Error).message).toContain("array");
    }
  });

  test("throws validation error on non-array exclude", async () => {
    try {
      await loadConfig(testFixtureDir, {
        exclude: "nope",
      } as unknown as Partial<MetonymConfig>);
      expect.unreachable("should have thrown");
    } catch (error) {
      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).toContain("exclude");
      expect((error as Error).message).toContain("array");
    }
  });

  test("throws validation error on non-array languages", async () => {
    try {
      await loadConfig(testFixtureDir, {
        languages: 123,
      } as unknown as Partial<MetonymConfig>);
      expect.unreachable("should have thrown");
    } catch (error) {
      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).toContain("languages");
      expect((error as Error).message).toContain("array");
    }
  });

  test("throws validation error on non-boolean inject", async () => {
    try {
      await loadConfig(testFixtureDir, {
        inject: "yes",
      } as unknown as Partial<MetonymConfig>);
      expect.unreachable("should have thrown");
    } catch (error) {
      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).toContain("inject");
      expect((error as Error).message).toContain("boolean");
    }
  });

  test("throws validation error on non-string outDir", async () => {
    try {
      await loadConfig(testFixtureDir, {
        outDir: 123,
      } as unknown as Partial<MetonymConfig>);
      expect.unreachable("should have thrown");
    } catch (error) {
      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).toContain("outDir");
      expect((error as Error).message).toContain("string");
    }
  });

  test("classifies various file extensions correctly", async () => {
    mkdirSync(resolve(testFixtureDir, "src"), { recursive: true });
    writeFileSync(resolve(testFixtureDir, "README.md"), "# Example\n");
    writeFileSync(resolve(testFixtureDir, "src/a.ts"), "");
    writeFileSync(resolve(testFixtureDir, "src/b.tsx"), "");
    writeFileSync(resolve(testFixtureDir, "src/c.js"), "");
    writeFileSync(resolve(testFixtureDir, "src/d.jsx"), "");
    writeFileSync(resolve(testFixtureDir, "src/e.mts"), "");
    writeFileSync(resolve(testFixtureDir, "src/f.cts"), "");
    writeFileSync(resolve(testFixtureDir, "src/g.mjs"), "");
    writeFileSync(resolve(testFixtureDir, "src/h.cjs"), "");

    const project = await scan({
      root: testFixtureDir,
      config: {
        include: ["README.md", "src/**/*.{ts,tsx,js,jsx,mts,cts,mjs,cjs}"],
      },
    });

    expect(project.sourceFiles).toContain("src/a.ts");
    expect(project.sourceFiles).toContain("src/b.tsx");
    expect(project.sourceFiles).toContain("src/c.js");
    expect(project.sourceFiles).toContain("src/d.jsx");
    expect(project.sourceFiles).toContain("src/e.mts");
    expect(project.sourceFiles).toContain("src/f.cts");
    expect(project.sourceFiles).toContain("src/g.mjs");
    expect(project.sourceFiles).toContain("src/h.cjs");
  });

  test("never includes files under outDir", async () => {
    mkdirSync(resolve(testFixtureDir, "src"), { recursive: true });
    mkdirSync(resolve(testFixtureDir, ".metonym/tests"), { recursive: true });

    writeFileSync(resolve(testFixtureDir, "README.md"), "# Example\n");
    writeFileSync(resolve(testFixtureDir, "src/a.ts"), "");
    writeFileSync(
      resolve(testFixtureDir, ".metonym/tests/README.md.test.ts"),
      "",
    );

    const project = await scan({
      root: testFixtureDir,
      config: { outDir: ".metonym/tests" },
    });

    expect(project.sourceFiles).toContain("src/a.ts");
    expect(project.sourceFiles).not.toContain(
      ".metonym/tests/README.md.test.ts",
    );
  });

  test("returns paths in posix format without leading ./", async () => {
    mkdirSync(resolve(testFixtureDir, "docs"), { recursive: true });
    mkdirSync(resolve(testFixtureDir, "src"), { recursive: true });

    writeFileSync(resolve(testFixtureDir, "README.md"), "");
    writeFileSync(resolve(testFixtureDir, "docs/guide.md"), "");
    writeFileSync(resolve(testFixtureDir, "src/index.ts"), "");

    const project = await scan({ root: testFixtureDir });

    for (const path of project.docFiles) {
      expect(path).not.toContain("\\");
      expect(path).not.toMatch(/^\.\//);
    }

    for (const path of project.sourceFiles) {
      expect(path).not.toContain("\\");
      expect(path).not.toMatch(/^\.\//);
    }
  });
});
