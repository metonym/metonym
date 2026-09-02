/**
 * Deterministic synthetic repo generator for benchmarking metonym.
 * No external dependencies, no Math.random().
 *
 * Usage (via script): bun bench/gen.ts <dir> <size>
 * Usage (via import): generateRepo(dir, size)
 */

// Simple seeded LCG for deterministic pseudo-randomness
class SeededRandom {
  private seed: number;

  constructor(seed: number = 12345) {
    this.seed = seed;
  }

  // Park-Miller LCG
  next(): number {
    this.seed = (this.seed * 16807) % 2147483647;
    return (this.seed - 1) / 2147483646;
  }

  // Returns integer in [min, max)
  intRange(min: number, max: number): number {
    return min + Math.floor(this.next() * (max - min));
  }

  pickN<T>(arr: T[], count: number): T[] {
    const result: T[] = [];
    const indices = new Set<number>();
    const targetCount = Math.min(count, arr.length);
    while (indices.size < targetCount) {
      indices.add(this.intRange(0, arr.length));
    }
    for (const i of indices) {
      result.push(arr[i]);
    }
    return result;
  }
}

const rng = new SeededRandom(42);

function generateMarkdownFile(
  docNum: number,
  rng: SeededRandom,
): { name: string; content: string; examples: number } {
  const headingCount = rng.intRange(3, 9);
  const exampleCount = rng.intRange(2, 6);

  let content = "";
  let examples = 0;

  for (let h = 0; h < headingCount; h++) {
    content += `${"#".repeat(1 + (h % 3))} Heading ${h + 1}\n\n`;
    content += `This is paragraph content for heading ${h + 1}.\n\n`;

    if (h < exampleCount) {
      const exIdx = h;
      content += `\`\`\`ts\n`;
      content += `const x${exIdx} = ${docNum} + ${exIdx};\n`;
      content += `expect(x${exIdx}).toBe(${docNum + exIdx});\n`;
      content += `\`\`\`\n\n`;
      examples++;

      // Occasionally add an inert JSON block
      if (exIdx % 3 === 0) {
        content += `\`\`\`json\n`;
        content += `{"example": ${exIdx}, "doc": ${docNum}}\n`;
        content += `\`\`\`\n\n`;
      }
    }
  }

  return {
    name: `docs/doc-${docNum}.md`,
    content,
    examples,
  };
}

function generateTypeScriptFile(
  modNum: number,
  rng: SeededRandom,
): { name: string; content: string; examples: number } {
  const fnCount = rng.intRange(2, 5);
  let content = "";
  let examples = 0;

  if (modNum > 0) {
    const prevMod = modNum - 1;
    content += `import { fn${prevMod}A } from "./mod-${prevMod}";\n`;
  }
  content += `\n`;

  for (let f = 0; f < fnCount; f++) {
    const fnName = `fn${modNum}${String.fromCharCode(65 + f)}`;

    // Self-contained so `metonym check` / runCached can pass. Calling the
    // function here would fail: generated tests don't import it, and the
    // return value isn't modNum * 10.
    if (f % 2 === 0) {
      content += `/**\n`;
      content += ` * Function ${fnName}.\n`;
      content += ` *\n`;
      content += ` * @example\n`;
      content += ` * \`\`\`ts\n`;
      content += ` * const result = ${modNum} + ${f};\n`;
      content += ` * expect(result).toBe(${modNum + f});\n`;
      content += ` * \`\`\`\n`;
      content += ` */\n`;
      examples++;
    }

    content += `export function ${fnName}(n: number): number {\n`;
    content += `  const x = n + ${f};\n`;
    content += `  const y = x * 2;\n`;
    content += `  const z = y - 1;\n`;
    content += `  if (z < 0) return 0;\n`;
    content += `  return z * ${modNum + 1};\n`;
    content += `}\n\n`;
  }

  return {
    name: `src/mod-${modNum}.ts`,
    content,
    examples,
  };
}

function generatePackageJson(): { name: string; content: string } {
  return {
    name: "package.json",
    content: JSON.stringify(
      {
        name: "bench-fixture",
        version: "1.0.0",
        metonym: { analysis: "shallow" },
      },
      null,
      2,
    ),
  };
}

function generateReadme(): { name: string; content: string; examples: number } {
  let content = `# Benchmark Fixture\n\nThis is a synthetic repository for benchmarking metonym.\n\n`;
  let examples = 0;

  for (let i = 0; i < 5; i++) {
    content += `## Example ${i + 1}\n\n`;
    content += `\`\`\`ts\n`;
    content += `const value${i} = ${i};\n`;
    content += `expect(value${i}).toBe(${i});\n`;
    content += `\`\`\`\n\n`;
    examples++;
  }

  return {
    name: "README.md",
    content,
    examples,
  };
}

export async function generateRepo(
  dir: string,
  size: "S" | "M",
): Promise<{ files: number; examples: number }> {
  const fileCount = size === "S" ? 100 : 2000;

  // 30% markdown docs, 70% ts sources
  const markdownCount = Math.floor(fileCount * 0.3);
  const sourceCount = fileCount - markdownCount;

  let totalExamples = 0;
  let totalFiles = 0;

  const absDir = dir;
  await Bun.spawn(["mkdir", "-p", absDir, `${absDir}/docs`, `${absDir}/src`], {
    stdio: ["ignore", "ignore", "ignore"],
  }).exited;

  const pkgJson = generatePackageJson();
  await Bun.file(`${absDir}/${pkgJson.name}`).write(pkgJson.content);
  totalFiles++;

  const readme = generateReadme();
  await Bun.file(`${absDir}/${readme.name}`).write(readme.content);
  totalFiles++;
  totalExamples += readme.examples;

  for (let i = 0; i < markdownCount; i++) {
    const doc = generateMarkdownFile(i, rng);
    await Bun.file(`${absDir}/${doc.name}`).write(doc.content);
    totalFiles++;
    totalExamples += doc.examples;
  }

  for (let i = 0; i < sourceCount; i++) {
    const src = generateTypeScriptFile(i, rng);
    await Bun.file(`${absDir}/${src.name}`).write(src.content);
    totalFiles++;
    totalExamples += src.examples;
  }

  return { files: totalFiles, examples: totalExamples };
}

if (import.meta.main) {
  const args = Bun.argv.slice(2);
  const dir = args[0] || ".";
  const size = (args[1] || "S") as "S" | "M";

  const result = await generateRepo(dir, size);
  console.log(
    `Generated ${result.files} files with ${result.examples} examples`,
  );
}
