import fsp from "node:fs/promises";
import path from "node:path";
import sharp from "sharp";
import { removeBackground } from "@imgly/background-removal-node";
import { runYtDlp } from "../lib/yt-dlp.js";
import { detectFaces } from "../face-tracking/onnx-face-detector.js";

/**
 * Raccoglie facce già scontornate dalle copertine dei canali YouTube (fatte da grafici: facce
 * nitide ed espressive), per la libreria delle copertine. NON decide chi è chi: il nome lo mette
 * simo dalla pagina "Facce" del sito. Gratis (nessuna AI a pagamento).
 * Uso: tsx src/dev/harvest-cover-faces.ts [--body] <cartella> <video per canale> <url canale> [url canale...]
 *      tsx src/dev/harvest-cover-faces.ts [--body] --local <cartella da cui leggere le copertine> <cartella>
 * --body: ritaglio "busto" (testa, spalle e un po' di petto) invece di "testa e collo": nelle
 *         copertine i busti salgono dal fondo, e con la sola testa sembrano teste enormi.
 * --local: rilavora le copertine già scaricate in <cartella da cui leggere>/covers, niente rete.
 */
const args = process.argv.slice(2);
const body = args.includes("--body");
const localIdx = args.indexOf("--local");
const localSource = localIdx >= 0 ? args[localIdx + 1] : undefined;
const rest = args.filter((a, i) => a !== "--body" && a !== "--local" && (localIdx < 0 || i !== localIdx + 1));
const [outDir, perChannelArg, ...channels] = rest;
if (!outDir || (!localSource && (!perChannelArg || channels.length === 0))) throw new Error("Uso: vedi il commento in cima al file");
const perChannel = Number(perChannelArg ?? "0");

const DETECT_W = 320;
const DETECT_H = 240;
/** Volti più bassi di così (su una copertina 1280x720) sono comparse: troppo piccoli da riusare. */
const MIN_FACE_HEIGHT = 120;

await fsp.mkdir(path.join(outDir, "covers"), { recursive: true });
await fsp.mkdir(path.join(outDir, "faces"), { recursive: true });
const index: Array<{ file: string; videoId: string; channel: string; face: { x: number; y: number; width: number; height: number; score: number } }> = [];

const sources = localSource ? [localSource] : channels;
for (const channel of sources) {
  const ids = localSource
    ? (await fsp.readdir(path.join(localSource, "covers"))).filter((f) => f.endsWith(".jpg")).map((f) => f.replace(/\.jpg$/, ""))
    : (await runYtDlp(["--flat-playlist", "--playlist-end", String(perChannel), "--print", "%(id)s", channel])).stdout
        .split("\n")
        .map((l) => l.trim())
        .filter((l) => /^[\w-]{11}$/.test(l));
  console.log(`${channel}: ${ids.length} video`);
  for (const id of ids) {
    const coverPath = localSource ? path.join(localSource, "covers", `${id}.jpg`) : path.join(outDir, "covers", `${id}.jpg`);
    try {
      await fsp.access(coverPath);
    } catch {
      if (localSource) continue;
      let res = await fetch(`https://i.ytimg.com/vi/${id}/maxresdefault.jpg`);
      if (!res.ok) res = await fetch(`https://i.ytimg.com/vi/${id}/hqdefault.jpg`);
      if (!res.ok) continue;
      await fsp.writeFile(coverPath, Buffer.from(await res.arrayBuffer()));
    }

    const cover = sharp(coverPath).resize(1280, 720, { fit: "cover" });
    const coverBuf = await cover.clone().jpeg().toBuffer();
    const rgb = await sharp(coverBuf).resize(DETECT_W, DETECT_H, { fit: "fill" }).removeAlpha().raw().toBuffer();
    const bgr = Buffer.alloc(rgb.length);
    for (let i = 0; i < rgb.length; i += 3) {
      bgr[i] = rgb[i + 2]!;
      bgr[i + 1] = rgb[i + 1]!;
      bgr[i + 2] = rgb[i]!;
    }
    const faces = (await detectFaces(bgr, 1280, 720)).filter((f) => f.height >= MIN_FACE_HEIGHT);

    for (const [n, f] of faces.entries()) {
      // Sotto la faccia di solito c'è la scritta della copertina: si scende poco (collo e spalle).
      const left = Math.max(0, Math.round(f.x - f.width * (body ? 1.0 : 0.7)));
      const top = Math.max(0, Math.round(f.y - f.height * 0.55));
      const right = Math.min(1280, Math.round(f.x + f.width * (body ? 2.0 : 1.7)));
      const bottom = Math.min(720, Math.round(f.y + f.height * (body ? 2.6 : 1.45)));
      if (right - left < 60 || bottom - top < 60) continue;
      const cropBuf = await sharp(coverBuf).extract({ left, top, width: right - left, height: bottom - top }).png().toBuffer();
      try {
        const blob = await removeBackground(new Blob([cropBuf], { type: "image/png" }));
        const cut = await sharp(Buffer.from(await blob.arrayBuffer())).trim().png().toBuffer();
        const file = `${id}-${n}.png`;
        await fsp.writeFile(path.join(outDir, "faces", file), cut);
        index.push({ file, videoId: id, channel, face: f });
      } catch (error) {
        console.warn(`scontorno fallito ${id}-${n}: ${error instanceof Error ? error.message : error}`);
      }
    }
  }
  await fsp.writeFile(path.join(outDir, "index.json"), JSON.stringify(index, null, 1));
}
console.log(`Facce raccolte: ${index.length}`);
