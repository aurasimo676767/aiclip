import sharp from "sharp";

const inputPath = process.argv[2];
const outputPath = process.argv[3] ?? "tmp/face-region.jpg";
const [left, top, width, height] = process.argv.slice(4, 8).map(Number) as [number, number, number, number];

await sharp(inputPath)
  .extract({ left, top, width, height })
  .toFile(outputPath);
console.log("scritto", outputPath);
