import { extract, generate, run, scan } from "metonym";

const project = await scan({ root: import.meta.dir });
const docs = await extract(project);
const generated = generate(docs);
const result = await run(docs, { generated });

process.stdout.write(`${JSON.stringify(result.totals)}\n`);

if (result.totals.failed > 0) {
  process.exitCode = 1;
} else if (result.exitCode !== 0) {
  process.stderr.write(
    "error: test run did not complete cleanly (see skipped examples)\n",
  );
  process.exitCode = 1;
} else if (result.totals.passed < 1) {
  process.stderr.write("error: pipeline ran no examples\n");
  process.exitCode = 1;
}
