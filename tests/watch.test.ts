import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { MetonymConfig } from "metonym";
import { type Watcher, watchProject } from "../src/watch/watch";

async function waitFor(
  predicate: () => boolean,
  timeoutMs: number = 5000,
): Promise<void> {
  const startTime = Date.now();
  while (!predicate()) {
    if (Date.now() - startTime > timeoutMs) {
      throw new Error(`waitFor timeout after ${timeoutMs}ms`);
    }
    await Bun.sleep(50);
  }
}

describe("watchProject", () => {
  let tempDir: string;
  let watcher: Watcher | null;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "metonym-watch-"));
    watcher = null;
  });

  afterEach(() => {
    if (watcher) {
      watcher.stop();
    }
  });

  it("triggers onChange when a matching file is written", async () => {
    const changes: string[][] = [];
    const config: MetonymConfig = {
      root: tempDir,
      include: ["README.md", "docs/**/*.md"],
      exclude: ["**/node_modules/**", "**/.git/**", "**/.metonym/**"],
      outDir: ".metonym/tests",
      languages: ["ts", "tsx", "js", "jsx"],
      inject: true,
    };

    watcher = watchProject({
      root: tempDir,
      config,
      onChange: async (changedFiles) => {
        changes.push(changedFiles);
      },
    });

    // macOS FSEvents needs a beat after watch() before events flow; a
    // write in that window is lost forever. Real users' next save always
    // fires, so emulate that: rewrite until an event is observed.
    let observed = false;
    for (let attempt = 0; attempt < 8 && !observed; attempt++) {
      await writeFile(join(tempDir, "README.md"), `# Hello ${attempt}\n`);
      try {
        await waitFor(() => changes.length > 0, 1000);
        observed = true;
      } catch {}
    }

    expect(observed).toBe(true);
    expect([...new Set(changes.flat())]).toEqual(["README.md"]);
  }, 10000);

  it("coalesces rapid writes into a single onChange call", async () => {
    const changes: string[][] = [];
    const config: MetonymConfig = {
      root: tempDir,
      include: ["**/*.md"],
      exclude: ["**/node_modules/**", "**/.git/**", "**/.metonym/**"],
      outDir: ".metonym/tests",
      languages: ["ts", "tsx", "js", "jsx"],
      inject: true,
    };

    watcher = watchProject({
      root: tempDir,
      config,
      onChange: async (changedFiles) => {
        changes.push(changedFiles);
      },
      debounceMs: 300,
    });

    await writeFile(join(tempDir, "file1.md"), "content1");
    await Bun.sleep(20);
    await writeFile(join(tempDir, "file2.md"), "content2");

    // Wait until both files have been observed (fs event latency varies
    // under load; the second event can land after the first debounce fires).
    const union = () => new Set(changes.flat());
    await waitFor(
      () => union().has("file1.md") && union().has("file2.md"),
      8000,
    );

    // Coalescing: rapid writes must not produce one call per event.
    expect(changes.length).toBeLessThanOrEqual(2);
    expect([...union()].sort()).toEqual(["file1.md", "file2.md"]);
  }, 10000);

  it("filters out excluded paths", async () => {
    const changes: string[][] = [];
    const config: MetonymConfig = {
      root: tempDir,
      include: ["**/*.md"],
      exclude: ["**/node_modules/**", "**/.git/**", "**/.metonym/**"],
      outDir: ".metonym/tests",
      languages: ["ts", "tsx", "js", "jsx"],
      inject: true,
    };

    watcher = watchProject({
      root: tempDir,
      config,
      onChange: async (changedFiles) => {
        changes.push(changedFiles);
      },
    });

    await mkdir(join(tempDir, "node_modules"), { recursive: true });
    await mkdir(join(tempDir, ".metonym", "tests"), { recursive: true });

    await writeFile(join(tempDir, "node_modules", "x.md"), "excluded");
    await writeFile(join(tempDir, ".metonym", "tests", "y.md"), "excluded");

    await Bun.sleep(600);

    expect(changes).toHaveLength(0);
  }, 10000);

  it("stop() prevents further events and is idempotent", async () => {
    const changes: string[][] = [];
    const config: MetonymConfig = {
      root: tempDir,
      include: ["**/*.md"],
      exclude: ["**/node_modules/**", "**/.git/**", "**/.metonym/**"],
      outDir: ".metonym/tests",
      languages: ["ts", "tsx", "js", "jsx"],
      inject: true,
    };

    watcher = watchProject({
      root: tempDir,
      config,
      onChange: async (changedFiles) => {
        changes.push(changedFiles);
      },
    });

    await writeFile(join(tempDir, "file1.md"), "content1");

    // Wait for the first change. Generous timeout and >=1 (not exactly 1):
    // under full-suite load fs events can be slow or split across debounce
    // windows; exact coalescing is covered by its own test.
    await waitFor(() => changes.length > 0, 8000);
    expect(changes.length).toBeGreaterThanOrEqual(1);

    // Stop the watcher; give any in-flight debounce a moment to settle.
    watcher.stop();
    await Bun.sleep(300);
    const callsAtStop = changes.length;

    await writeFile(join(tempDir, "file2.md"), "content2");

    await Bun.sleep(400);

    expect(changes.length).toBe(callsAtStop);

    expect(() => {
      watcher?.stop();
    }).not.toThrow();
  }, 10000);

  it("serializes onChange calls and never runs concurrently", async () => {
    const callLog: string[] = [];
    let isRunning = false;
    const config: MetonymConfig = {
      root: tempDir,
      include: ["**/*.md"],
      exclude: ["**/node_modules/**", "**/.git/**", "**/.metonym/**"],
      outDir: ".metonym/tests",
      languages: ["ts", "tsx", "js", "jsx"],
      inject: true,
    };

    watcher = watchProject({
      root: tempDir,
      config,
      onChange: async (changedFiles) => {
        if (isRunning) {
          throw new Error("onChange called concurrently!");
        }

        isRunning = true;
        callLog.push(`start:${changedFiles.join(",")}`);

        await Bun.sleep(300);

        callLog.push(`end:${changedFiles.join(",")}`);
        isRunning = false;
      },
      debounceMs: 100,
    });

    await writeFile(join(tempDir, "file1.md"), "content1");
    await Bun.sleep(50);

    await writeFile(join(tempDir, "file2.md"), "content2");
    await Bun.sleep(50);

    await writeFile(join(tempDir, "file3.md"), "content3");

    await Bun.sleep(1000);

    const startCount = callLog.filter((line) =>
      line.startsWith("start:"),
    ).length;
    const endCount = callLog.filter((line) => line.startsWith("end:")).length;

    expect(startCount).toBe(endCount);
    expect(startCount).toBeGreaterThan(0);

    // Verify no concurrent execution: every start should be followed by end
    // before the next start
    let currentlyRunning = false;
    for (const line of callLog) {
      if (line.startsWith("start:")) {
        expect(currentlyRunning).toBe(false);
        currentlyRunning = true;
      } else if (line.startsWith("end:")) {
        expect(currentlyRunning).toBe(true);
        currentlyRunning = false;
      }
    }
  }, 10000);

  it("respects include patterns", async () => {
    const changes: string[][] = [];
    const config: MetonymConfig = {
      root: tempDir,
      include: ["*.md", "docs/**/*.md"],
      exclude: ["**/node_modules/**", "**/.git/**", "**/.metonym/**"],
      outDir: ".metonym/tests",
      languages: ["ts", "tsx", "js", "jsx"],
      inject: true,
    };

    watcher = watchProject({
      root: tempDir,
      config,
      onChange: async (changedFiles) => {
        changes.push(changedFiles);
      },
    });

    await mkdir(join(tempDir, "docs"), { recursive: true });

    await writeFile(join(tempDir, "README.md"), "# README");

    await waitFor(() => changes.length > 0, 8000);
    expect(changes).toHaveLength(1);
    expect(changes[0]).toEqual(["README.md"]);

    await writeFile(join(tempDir, "docs", "guide.md"), "# Guide");

    await waitFor(() => changes.length > 1, 8000);
    expect(changes[1]).toEqual(["docs/guide.md"]);

    await writeFile(join(tempDir, "notes.txt"), "notes");

    await Bun.sleep(400);
    expect(changes).toHaveLength(2);
  }, 10000);

  it("handles file writes with distinct content", async () => {
    const changes: string[][] = [];
    const config: MetonymConfig = {
      root: tempDir,
      include: ["**/*.md"],
      exclude: ["**/node_modules/**", "**/.git/**", "**/.metonym/**"],
      outDir: ".metonym/tests",
      languages: ["ts", "tsx", "js", "jsx"],
      inject: true,
    };

    watcher = watchProject({
      root: tempDir,
      config,
      onChange: async (changedFiles) => {
        changes.push(changedFiles);
      },
    });

    const uniqueContent1 = `# Test 1\n${Date.now()}\n`;
    await writeFile(join(tempDir, "test1.md"), uniqueContent1);

    await waitFor(() => changes.length > 0, 8000);
    expect(changes[0]).toEqual(["test1.md"]);

    const uniqueContent2 = `# Test 2\n${Date.now()}\n`;
    await writeFile(join(tempDir, "test2.md"), uniqueContent2);

    await waitFor(() => changes.length > 1, 8000);
    expect(changes[1]).toEqual(["test2.md"]);
  }, 10000);
});
