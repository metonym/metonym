import { join } from "node:path";

const irPath = join(import.meta.dir, "..", ".metonym", "ir.json");
const ir = await Bun.file(irPath).json();

const lines = ["# API", ""];
for (const sym of ir.symbols ?? []) {
  lines.push(`## ${sym.name}`, "");
  if (sym.signature) lines.push(`\`${sym.signature}\``, "");
  if (sym.description) lines.push(sym.description, "");
}

lines.push("## Examples", "");
for (const ex of ir.examples ?? []) {
  const n = Array.isArray(ex.hovers) ? ex.hovers.length : 0;
  lines.push(`- ${ex.title} (${n} hovers)`);
}
lines.push("");

const page = lines.join("\n");
await Bun.write(join(import.meta.dir, "..", ".metonym", "index.md"), page);
process.stdout.write(page);
