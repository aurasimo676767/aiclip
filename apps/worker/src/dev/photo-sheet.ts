import fsp from "node:fs/promises";
import path from "node:path";
import sharp from "sharp";

/** Foglio numerato (1, 2, 3...) di foto, in ordine di nome file. Uso: tsx src/dev/photo-sheet.ts <cartella> <out.jpg> [colonne=4] */
const [dir, out, colsArg = "4"] = process.argv.slice(2);
const files = (await fsp.readdir(dir!)).filter((f) => /\.(jpe?g|png)$/i.test(f)).sort();
const cell = 300;
const cols = Number(colsArg);
const rows = Math.ceil(files.length / cols);
const tiles = await Promise.all(
  files.map(async (f, i) => ({ input: await sharp(path.join(dir!, f)).rotate().resize(cell - 10, cell - 10, { fit: "cover" }).jpeg().toBuffer(), left: (i % cols) * cell + 5, top: Math.floor(i / cols) * cell + 5 })),
);
const labels = files
  .map((_, i) => `<rect x="${(i % cols) * cell + 10}" y="${Math.floor(i / cols) * cell + 10}" width="54" height="44" rx="8" fill="#ffd400" stroke="#000" stroke-width="3"/><text x="${(i % cols) * cell + 37}" y="${Math.floor(i / cols) * cell + 43}" text-anchor="middle" font-size="30" font-weight="bold" font-family="Arial" fill="#000">${i + 1}</text>`)
  .join("");
const base = await sharp({ create: { width: cols * cell, height: rows * cell, channels: 3, background: "#222" } }).composite(tiles).png().toBuffer();
await sharp(base).composite([{ input: Buffer.from(`<svg width="${cols * cell}" height="${rows * cell}" xmlns="http://www.w3.org/2000/svg">${labels}</svg>`), left: 0, top: 0 }]).jpeg({ quality: 85 }).toFile(out!);
console.log(files.map((f, i) => `${i + 1}=${f}`).join(" "));
