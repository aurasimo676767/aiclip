import "dotenv/config";
import fsp from "node:fs/promises";
import path from "node:path";
import { runFfmpeg } from "../lib/ffmpeg.js";
import { selectThumbnailAssets } from "../providers/ai/thumbnail-selection.js";
import { env } from "../env.js";

/**
 * Prova la scelta AI della copertina (tipo, gioco, scritta, colore) su un tratto di un sorgente
 * locale, senza toccare YouTube. A PAGAMENTO (Haiku, ~0,003 $ a prova).
 * Uso: tsx src/dev/test-cover-selection.ts <sorgente> <inizio> <fine> "<titolo clip>" "<riassunto>"
 */
const [src, s, e, title, hook] = process.argv.slice(2);
const start = Number(s);
const end = Number(e);
const dir = path.resolve("tmp", "cover-selection-test");
await fsp.mkdir(dir, { recursive: true });
const frames: string[] = [];
for (let i = 0; i < 8; i++) {
  const t = start + ((end - start) * (i + 1)) / 9;
  const out = path.join(dir, `f${i}.jpg`);
  await runFfmpeg(["-y", "-ss", t.toFixed(1), "-i", src!, "-frames:v", "1", "-vf", "scale=768:-2", "-q:v", "4", out]);
  frames.push((await fsp.readFile(out)).toString("base64"));
}
const selection = await selectThumbnailAssets({
  apiKey: env.ANTHROPIC_API_KEY,
  model: env.ANTHROPIC_MODEL_CHEAP,
  clipTitle: title!,
  clipHook: hook ?? "",
  clipCaption: "",
  frameJpegsBase64: frames,
});
console.log(JSON.stringify({ tipo: selection.kind, gioco: selection.gameName, scritta: selection.coverWords, colore: selection.coverColor, espressione: selection.desiredExpression, reazioneA: selection.reactedVideoQuery }));
await fsp.rm(dir, { recursive: true, force: true });
