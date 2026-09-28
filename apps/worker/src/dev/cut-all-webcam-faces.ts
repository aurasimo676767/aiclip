import fsp from "node:fs/promises";
import path from "node:path";
import sharp from "sharp";
import { detectFaces } from "../face-tracking/onnx-face-detector.js";
import { cutBustFromPhoto } from "../render/bust-cutout.js";

/**
 * Come cut-webcam-faces.ts, ma ritaglia TUTTE le facce di ogni fotogramma (una per webcam), non
 * solo la più grande: nelle live di gruppo chi serve (es. Pesh) spesso è nella webcam più piccola.
 * Non sa chi è chi: i nomi li dà simo guardando il foglio. Gratis.
 * Uso: tsx src/dev/cut-all-webcam-faces.ts <cartella di uscita> <fotogramma> [fotogramma...]
 */
const MIN_FACE_PX = 45;
const [outDir, ...frames] = process.argv.slice(2);
if (!outDir || frames.length === 0) throw new Error("Uso: tsx src/dev/cut-all-webcam-faces.ts <cartella di uscita> <fotogramma>...");
await fsp.mkdir(outDir, { recursive: true });
let n = 0;
for (const frame of frames) {
  const img = sharp(frame);
  const { width, height } = await img.metadata();
  if (!width || !height) continue;
  const rgb = await img.clone().resize(320, 240, { fit: "fill" }).removeAlpha().raw().toBuffer();
  const bgr = Buffer.alloc(rgb.length);
  for (let i = 0; i < rgb.length; i += 3) {
    bgr[i] = rgb[i + 2]!;
    bgr[i + 1] = rgb[i + 1]!;
    bgr[i + 2] = rgb[i]!;
  }
  const faces = (await detectFaces(bgr, width, height)).filter((f) => f.width >= MIN_FACE_PX);
  for (const [k, f] of faces.entries()) {
    // Zona attorno alla faccia (la sua webcam, più o meno): dentro c'è una faccia sola, la più grande.
    const left = Math.max(0, Math.round(f.x - f.width * 1.6));
    const top = Math.max(0, Math.round(f.y - f.height * 1.0));
    const right = Math.min(width, Math.round(f.x + f.width * 2.6));
    const bottom = Math.min(height, Math.round(f.y + f.height * 3.4));
    try {
      const region = await img.clone().extract({ left, top, width: right - left, height: bottom - top }).png().toBuffer();
      const cut = await cutBustFromPhoto(region);
      if (!cut) continue;
      await fsp.writeFile(path.join(outDir, `${path.basename(frame).replace(/\.[^.]+$/, "")}_${k}.png`), cut);
      n++;
    } catch (err) {
      console.warn(`ritaglio fallito ${path.basename(frame)} #${k}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
}
console.log(`ritagli: ${n}`);
