import fsp from "node:fs/promises";
import path from "node:path";
import sharp from "sharp";
import { removeBackground } from "@imgly/background-removal-node";

/**
 * Confronta i modelli di scontorno (medium/large) sugli stessi ritagli: foglio con le versioni
 * affiancate su sfondo colorato. Uso: tsx src/dev/compare-bg-models.ts <out.jpg> <copertina.jpg:left,top,w,h> ...
 */
const [out, ...items] = process.argv.slice(2);
const rows: Buffer[] = [];
for (const item of items) {
  const [file, box] = item.split("::");
  const [left, top, width, height] = box!.split(",").map(Number);
  const crop = await sharp(file!).resize(1280, 720, { fit: "cover" }).extract({ left: left!, top: top!, width: width!, height: height! }).png().toBuffer();
  const cells: Buffer[] = [];
  for (const model of ["medium", "large"] as const) {
    const t = Date.now();
    const blob = await removeBackground(new Blob([crop], { type: "image/png" }), { model });
    const png = Buffer.from(await blob.arrayBuffer());
    console.log(model, path.basename(file!), `${Date.now() - t}ms`);
    cells.push(await sharp(png).resize(360, 360, { fit: "contain", background: { r: 40, g: 110, b: 200, alpha: 1 } }).flatten({ background: "#286ec8" }).jpeg().toBuffer());
  }
  rows.push(await sharp({ create: { width: 730, height: 360, channels: 3, background: "#111" } }).composite([{ input: cells[0]!, left: 0, top: 0 }, { input: cells[1]!, left: 370, top: 0 }]).jpeg().toBuffer());
}
await sharp({ create: { width: 730, height: 370 * rows.length, channels: 3, background: "#111" } })
  .composite(rows.map((r, i) => ({ input: r, left: 0, top: i * 370 })))
  .jpeg()
  .toFile(out!);
console.log("ok");
