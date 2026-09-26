import fsp from "node:fs/promises";
import path from "node:path";
import { cutBustFromPhoto } from "../render/bust-cutout.js";

/**
 * Ritaglia i busti da foto o fotogrammi (es. clip Twitch) SENZA toccare la libreria: servono a
 * simo per dire chi è chi (nelle clip compaiono ospiti e webcam di altri streamer). Quelli che
 * conferma si importano poi con add-labeled-faces --cutout. Gratis.
 * Uso: tsx src/dev/cut-webcam-faces.ts <cartella di uscita> <foto> [foto...]
 */
const [outDir, ...photos] = process.argv.slice(2);
if (!outDir || photos.length === 0) throw new Error("Uso: tsx src/dev/cut-webcam-faces.ts <cartella di uscita> <foto>...");
await fsp.mkdir(outDir, { recursive: true });
let n = 0;
for (const photo of photos) {
  try {
    const cut = await cutBustFromPhoto(photo);
    if (!cut) continue;
    await fsp.writeFile(path.join(outDir, `${path.basename(photo).replace(/\.[^.]+$/, "")}.png`), cut);
    n++;
  } catch (err) {
    console.warn(`scontorno fallito ${path.basename(photo)}: ${err instanceof Error ? err.message : String(err)}`);
  }
}
console.log(`ritagli: ${n} su ${photos.length}`);
