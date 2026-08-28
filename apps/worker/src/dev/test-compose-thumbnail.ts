import { composeThumbnail } from "../render/compose-thumbnail.js";

const backgroundPath = process.argv[2];
const faceCutoutPath = process.argv[3] || null;
if (!backgroundPath) {
  console.error("Uso: tsx src/dev/test-compose-thumbnail.ts <sfondo.jpg> [faccia-ritagliata.png]");
  process.exit(1);
}

await composeThumbnail({
  backgroundFramePath: backgroundPath,
  faceCutoutPngPath: faceCutoutPath,
  bannerText: "BLUR REACTION",
  headlineText: "Scappa da 100 poliziotti e vince 500.000 euro",
  headlineHighlightWords: ["500.000"],
  outputPath: "tmp/compose-test.jpg",
});
console.log("scritto tmp/compose-test.jpg");
