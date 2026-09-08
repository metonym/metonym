/**
 * Tests for extract()'s per-file failure isolation: an unreadable or
 * binary file skips itself (with a warning) instead of aborting the run.
 */

import { expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import { extract, scan } from "metonym";

test("extract: unreadable and binary files are skipped, not fatal", async () => {
  const root = await fs.mkdtemp("/tmp/metonym-extract-test-");
  try {
    await fs.mkdir(`${root}/docs`, { recursive: true });
    await fs.writeFile(
      `${root}/package.json`,
      JSON.stringify({ name: "test-pkg" }),
    );
    await fs.writeFile(
      `${root}/README.md`,
      `# Test\n\n\`\`\`ts\nexpect(1).toBe(1)\n\`\`\`\n`,
    );
    await fs.writeFile(`${root}/docs/bin.md`, "# Bin\n\0binary content\n");

    const canChmod = process.platform !== "win32" && process.getuid?.() !== 0;
    if (canChmod) {
      await fs.writeFile(`${root}/docs/bad.md`, "# Bad\n");
      await fs.chmod(`${root}/docs/bad.md`, 0o000);
    }

    const project = await scan({ root });
    const docs = await extract(project);

    expect(
      docs.examples.some((ex) => ex.code.includes("expect(1).toBe(1)")),
    ).toBe(true);
    expect(docs.warnings?.length).toBe(canChmod ? 2 : 1);
    expect(docs.warnings?.some((w) => w.includes("binary file"))).toBe(true);
    if (canChmod) {
      expect(docs.warnings?.some((w) => w.includes("docs/bad.md"))).toBe(true);
    }
  } finally {
    if (process.platform !== "win32" && process.getuid?.() !== 0) {
      await fs.chmod(`${root}/docs/bad.md`, 0o644).catch(() => {});
    }
    await fs.rm(root, { recursive: true, force: true });
  }
});
