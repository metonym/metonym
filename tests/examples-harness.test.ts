import { afterAll, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  artifactPresent,
  discoverRecipes,
  MISSING_ARTIFACT,
  main,
} from "../scripts/run-examples.ts";

const temps: string[] = [];

async function tempDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  temps.push(dir);
  return dir;
}

afterAll(async () => {
  await Promise.all(temps.map((d) => rm(d, { recursive: true, force: true })));
});

function captureIo() {
  const stdout: string[] = [];
  const stderr: string[] = [];
  return {
    io: {
      stdout: {
        write(chunk: string) {
          stdout.push(chunk);
        },
      },
      stderr: {
        write(chunk: string) {
          stderr.push(chunk);
        },
      },
    },
    stdout,
    stderr,
  };
}

describe("examples harness", () => {
  test("missing package/ errors clearly", async () => {
    const root = await tempDir("metonym-examples-missing-");
    expect(artifactPresent(root)).toBe(false);
    const { io, stderr } = captureIo();
    const exit = await main(root, io);
    expect(exit).toBe(1);
    expect(stderr.join("")).toBe(MISSING_ARTIFACT);
  });

  test("a recipe without a check/coverage/extract script fails before install", async () => {
    const root = await tempDir("metonym-examples-noscript-");
    await mkdir(join(root, "package"));
    await writeFile(
      join(root, "package", "package.json"),
      JSON.stringify({ name: "metonym" }),
    );
    await mkdir(join(root, "examples", "incomplete"), { recursive: true });
    await writeFile(
      join(root, "examples", "incomplete", "package.json"),
      JSON.stringify({ name: "incomplete", private: true }),
    );

    const found = await discoverRecipes(join(root, "examples"));
    expect(found).toEqual([
      {
        name: "incomplete",
        dir: join(root, "examples", "incomplete"),
        script: undefined,
      },
    ]);

    const { io, stderr } = captureIo();
    const exit = await main(root, io);
    expect(exit).toBe(1);
    expect(stderr.join("")).toContain(
      'incomplete needs a "check", "coverage", or "extract" script in package.json',
    );
  });

  test("a recipe with a passing check script is counted", async () => {
    const root = await tempDir("metonym-examples-ok-");
    await mkdir(join(root, "package"));
    await writeFile(
      join(root, "package", "package.json"),
      JSON.stringify({ name: "metonym" }),
    );
    await mkdir(join(root, "examples", "ok"), { recursive: true });
    await writeFile(
      join(root, "examples", "ok", "package.json"),
      JSON.stringify({
        name: "ok",
        private: true,
        scripts: { check: "bun --print 1" },
      }),
    );

    const { io, stderr } = captureIo();
    const exit = await main(root, io);
    expect(exit).toBe(0);
    expect(stderr.join("")).toContain("1 example(s) passed");
  }, 20_000);

  test("runs every recipe before reporting failures", async () => {
    const root = await tempDir("metonym-examples-all-");
    await mkdir(join(root, "package"));
    await writeFile(
      join(root, "package", "package.json"),
      JSON.stringify({ name: "metonym" }),
    );

    await mkdir(join(root, "examples", "aaa-fail"), { recursive: true });
    await writeFile(
      join(root, "examples", "aaa-fail", "package.json"),
      JSON.stringify({
        name: "aaa-fail",
        private: true,
        scripts: { check: "bun -e 'process.exit(1)'" },
      }),
    );
    await mkdir(join(root, "examples", "zzz-ok"), { recursive: true });
    await writeFile(
      join(root, "examples", "zzz-ok", "package.json"),
      JSON.stringify({
        name: "zzz-ok",
        private: true,
        scripts: { check: "bun --print 1" },
      }),
    );

    const { io, stderr } = captureIo();
    const exit = await main(root, io);
    const err = stderr.join("");
    expect(exit).toBe(1);
    expect(err).toContain("[aaa-fail] exit 1");
    expect(err).toContain("[zzz-ok] exit 0");
    expect(err).toContain("1 example(s) failed: aaa-fail");
  }, 20_000);
});
