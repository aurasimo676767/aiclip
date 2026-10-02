import fs from "node:fs";
import path from "node:path";
import sharp from "sharp";

/**
 * Foglio numerato dei primi piani raccolti da harvest-stream-faces (per farli confermare a simo):
 * i migliori e diversi fra loro (almeno N minuti di distanza nella stessa live), faccia più grande
 * prima. Scrive anche <canale>-order.txt con numero → file.
 * Uso: tsx src/dev/harvest-sheet.ts <cartella> <canale> [max=24] [minuti_distanza=6]
 */
const [dir, channel, maxArg = "24", gapArg = "6"] = process.argv.slice(2);
const all = JSON.parse(fs.readFileSync(path.join(dir!, `${channel}.json`), "utf8")) as Array<{ file: string; vod: string; t: number; faceH: number }>;
const picked: typeof all = [];
for (const c of [...all].sort((a, b) => b.faceH - a.faceH)) {
  if (picked.some((p) => p.vod === c.vod && Math.abs(p.t - c.t) < Number(gapArg) * 60)) continue;
  picked.push(c);
  if (picked.length >= Number(maxArg)) break;
}
const cell = 240;
const cols = 6;
const rows = Math.ceil(picked.length / cols);
const tiles = await Promise.all(picked.map(async (p, i) => ({ input: await sharp(p.file).resize(cell - 6, cell - 6, { fit: "cover" }).toBuffer(), left: (i % cols) * cell + 3, top: Math.floor(i / cols) * cell + 3 })));
const nums = picked
  .map((_, i) => `<rect x="${(i % cols) * cell + 6}" y="${Math.floor(i / cols) * cell + 6}" width="56" height="44" rx="8" fill="#000" fill-opacity="0.75"/><text x="${(i % cols) * cell + 34}" y="${Math.floor(i / cols) * cell + 40}" font-size="34" font-weight="bold" text-anchor="middle" fill="#ffd400" font-family="Arial">${i + 1}</text>`)
  .join("");
const out = path.join(dir!, `sheet-${channel}.jpg`);
await sharp({ create: { width: cols * cell, height: rows * cell, channels: 3, background: "#222" } })
  .composite([...tiles, { input: Buffer.from(`<svg width="${cols * cell}" height="${rows * cell}" xmlns="http://www.w3.org/2000/svg">${nums}</svg>`), left: 0, top: 0 }])
  .jpeg({ quality: 85 })
  .toFile(out);
fs.writeFileSync(path.join(dir!, `${channel}-order.txt`), picked.map((p, i) => `${i + 1} ${p.file}`).join("\n"));
console.log(`${picked.length} foto → ${out}`);
