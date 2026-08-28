import fsp from "node:fs/promises";
import { removeBackground } from "@imgly/background-removal-node";

const inputPath = process.argv[2];
const outputPath = process.argv[3] ?? "tmp/bg-removed-test.png";
if (!inputPath) {
  console.error("Uso: tsx src/dev/test-bg-removal.ts <input.jpg> [output.png]");
  process.exit(1);
}

const t0 = Date.now();
const blob = await removeBackground(inputPath);
const buffer = Buffer.from(await blob.arrayBuffer());
await fsp.mkdir("tmp", { recursive: true });
await fsp.writeFile(outputPath, buffer);
console.log(`OK in ${((Date.now() - t0) / 1000).toFixed(1)}s — scritto ${outputPath} (${buffer.length} byte)`);
