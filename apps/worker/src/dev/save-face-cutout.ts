import fsp from "node:fs/promises";
import path from "node:path";
import sharp from "sharp";
import { removeBackground } from "@imgly/background-removal-node";

const [inputPath, aliasLower, leftS, topS, widthS, heightS] = process.argv.slice(2, 8);
if (!inputPath || !aliasLower || !leftS || !topS || !widthS || !heightS) {
  console.error("Uso: tsx src/dev/save-face-cutout.ts <fotogramma.jpg> <alias-minuscolo> <left> <top> <width> <height>");
  process.exit(1);
}

const facesDir = path.join("assets/streamer-faces", aliasLower);
await fsp.mkdir(facesDir, { recursive: true });

const existing = (await fsp.readdir(facesDir)).filter((f) => /\.png$/i.test(f));
const nextIndex = existing.length + 1;

const cropPath = path.join("tmp", `crop-${aliasLower}-${nextIndex}.jpg`);
await fsp.mkdir("tmp", { recursive: true });
await sharp(inputPath)
  .extract({ left: Number(leftS), top: Number(topS), width: Number(widthS), height: Number(heightS) })
  .toFile(cropPath);

const blob = await removeBackground(cropPath);
const outputPath = path.join(facesDir, `${nextIndex}.png`);
await fsp.writeFile(outputPath, Buffer.from(await blob.arrayBuffer()));
await fsp.rm(cropPath, { force: true });

console.log("salvato", outputPath);
