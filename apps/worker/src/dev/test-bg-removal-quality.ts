import fsp from "node:fs/promises";
import { removeBackground } from "@imgly/background-removal-node";

const inputPath = process.argv[2];
const outputPath = process.argv[3] ?? "tmp/bg-removed-quality-test.png";
const model = (process.argv[4] as "small" | "medium" | "large") ?? "large";
if (!inputPath) {
  console.error("Uso: tsx src/dev/test-bg-removal-quality.ts <input.jpg> [output.png] [small|medium|large]");
  process.exit(1);
}

const t0 = Date.now();
const blob = await removeBackground(inputPath, { model });
const buffer = Buffer.from(await blob.arrayBuffer());
await fsp.mkdir("tmp", { recursive: true });
await fsp.writeFile(outputPath, buffer);
console.log(`OK (model=${model}) in ${((Date.now() - t0) / 1000).toFixed(1)}s — scritto ${outputPath}`);
