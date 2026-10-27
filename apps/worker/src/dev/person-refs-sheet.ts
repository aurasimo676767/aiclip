import "dotenv/config";
import fs from "node:fs";
import path from "node:path";
import sharp from "sharp";
import { readFaceLibrary } from "../lib/face-library.js";
import { downloadFaces } from "../pipeline/cover-builder.js";
import { bestHeadCrops } from "../pipeline/face-reference.js";

/**
 * Foglio di controllo delle foto di una persona per le copertine (gratis): sopra i 5 primi piani che
 * GPT Image riceve come riferimento, sotto tutte le foto con quel nome, numerate. Serve a simo per
 * dire se qualcuna è etichettata male: chi è chi lo dice SOLO lui.
 * Uso: tsx src/dev/person-refs-sheet.ts <user_id> <NOME> <out.jpg>
 */
const [userId, name, out] = process.argv.slice(2);
const dir = path.join("tmp", `refs-${name}`);
fs.mkdirSync(dir, { recursive: true });
const library = await readFaceLibrary(userId!, dir);
const faces = library.faces.filter((f) => f.status === "labeled" && f.label === name && !f.tags?.includes("meme"));
const crops = await bestHeadCrops(library, name!, 5, dir);
const files = await downloadFaces(faces, dir);

// Il numero sta DENTRO la foto, nell'angolo: con la striscia sopra simo lo leggeva come didascalia
// della foto di sopra (2026-10-27: "il 6 addirittura è nero" era la casella vuota).
const TILE = 260;
const GAP = 10;
const CELL = TILE + GAP;
const badge = (text: string) => {
  const w = 22 + text.length * 19;
  return Buffer.from(`<svg width="${w}" height="44"><rect width="${w}" height="44" rx="8" fill="#000" fill-opacity="0.8"/><text x="11" y="32" font-size="30" font-family="Arial" font-weight="bold" fill="#ffeb3b">${text}</text></svg>`);
};
async function tile(file: string, text: string): Promise<Buffer> {
  return sharp(file)
    .resize(TILE, TILE, { fit: "contain", background: "#808080" })
    .flatten({ background: "#808080" })
    .composite([{ input: badge(text), top: 6, left: 6 }])
    .png()
    .toBuffer();
}
const cols = 6;
const usedIds = new Set(crops.map((c) => c.face.id));
const tiles = [
  ...(await Promise.all(crops.map((c, i) => tile(c.path, `RIF ${i + 1}`)))),
  ...(await Promise.all(faces.map((f, i) => tile(files[i]!, `${i + 1}${usedIds.has(f.id) ? " *" : ""}`)))),
];
const rows = Math.ceil(crops.length / cols) + Math.ceil(faces.length / cols);
const sheet = sharp({ create: { width: cols * CELL, height: rows * CELL, channels: 3, background: "#222" } });
const composites: sharp.OverlayOptions[] = [];
let row = 0;
crops.forEach((_, i) => composites.push({ input: tiles[i]!, left: (i % cols) * CELL, top: (row + Math.floor(i / cols)) * CELL }));
row += Math.ceil(crops.length / cols);
faces.forEach((_, i) => composites.push({ input: tiles[crops.length + i]!, left: (i % cols) * CELL, top: (row + Math.floor(i / cols)) * CELL }));
await sheet.composite(composites).jpeg({ quality: 85 }).toFile(out!);
console.log(`${name}: ${faces.length} foto col nome, ${crops.length} usate come riferimento → ${out}`);
console.log(crops.map((c, i) => `RIF ${i + 1} = ${faces.findIndex((f) => f.id === c.face.id) + 1} (girata ${c.turn?.toFixed(2) ?? "?"}, live ${c.face.sourceVideoId.slice(0, 8)})`).join("\n"));
console.log(faces.map((f, i) => `${i + 1}${usedIds.has(f.id) ? "*" : ""}=${f.id}`).join("  "));
fs.rmSync(dir, { recursive: true, force: true });
