import fsp from "node:fs/promises";
import path from "node:path";
import sharp from "sharp";

/** Foglio di controllo di PNG scontornati su sfondo a scacchi. Uso: tsx src/dev/face-sheet.ts <cartella png> <out.jpg> [colonne] [max] */
const [dir, out, colsArg = "8", maxArg = "64"] = process.argv.slice(2);
const files = (await fsp.readdir(dir!)).filter((f) => f.endsWith(".png")).slice(0, Number(maxArg));
const cell = 200;
const cols = Number(colsArg);
const rows = Math.ceil(files.length / cols);
const tiles = await Promise.all(
  files.map(async (f, i) => ({
    input: await sharp(path.join(dir!, f)).resize(cell - 8, cell - 22, { fit: "contain", background: { r: 0, g: 0, b: 0, alpha: 0 } }).png().toBuffer(),
    left: (i % cols) * cell + 4,
    top: Math.floor(i / cols) * cell + 4,
  })),
);
const labels = files.map((f, i) => `<text x="${(i % cols) * cell + 6}" y="${Math.floor(i / cols) * cell + cell - 6}" font-size="13" fill="#fff" font-family="Arial">${i}: ${f.slice(0, 22)}</text>`).join("");
const svg = Buffer.from(`<svg width="${cols * cell}" height="${rows * cell}" xmlns="http://www.w3.org/2000/svg"><defs><pattern id="c" width="20" height="20" patternUnits="userSpaceOnUse"><rect width="20" height="20" fill="#2c4a6e"/><rect width="10" height="10" fill="#355a85"/><rect x="10" y="10" width="10" height="10" fill="#355a85"/></pattern></defs><rect width="100%" height="100%" fill="url(#c)"/>${labels}</svg>`);
await sharp(svg).composite(tiles).jpeg({ quality: 85 }).toFile(out!);
console.log("ok", files.length);
