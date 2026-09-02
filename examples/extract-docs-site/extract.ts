import { mkdir } from "node:fs/promises";
import { join } from "node:path";

const root = import.meta.dir;
const cli = join(root, "node_modules", "metonym", "cli.js");

async function main(): Promise<number> {
  const proc = Bun.spawn([process.execPath, cli, "extract", "--format=json"], {
    cwd: root,
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);

  if (exitCode !== 0) {
    process.stderr.write(stderr);
    process.stderr.write(`error: metonym extract exited ${exitCode}\n`);
    return 1;
  }

  const ir: unknown = JSON.parse(stdout);
  if (typeof ir !== "object" || ir === null) {
    process.stderr.write("error: extract IR is not an object\n");
    return 1;
  }

  const examples = "examples" in ir ? ir.examples : undefined;
  if (!Array.isArray(examples) || examples.length === 0) {
    process.stderr.write("error: extract IR has no examples\n");
    return 1;
  }

  const withHovers = examples.filter(
    (e: unknown) =>
      typeof e === "object" &&
      e !== null &&
      "hovers" in e &&
      Array.isArray(e.hovers) &&
      e.hovers.length > 0,
  );
  if (withHovers.length === 0) {
    process.stderr.write(
      "error: extract IR has no hover metadata; is typescript installed?\n",
    );
    return 1;
  }

  await mkdir(join(root, ".metonym"), { recursive: true });
  await Bun.write(join(root, ".metonym", "ir.json"), stdout);

  const render = Bun.spawn(
    [process.execPath, join(root, "site", "render.ts")],
    {
      cwd: root,
      stdout: "inherit",
      stderr: "inherit",
    },
  );
  const renderExit = await render.exited;
  if (renderExit !== 0) {
    process.stderr.write(`error: site/render.ts exited ${renderExit}\n`);
    return 1;
  }
  return 0;
}

process.exitCode = await main();
