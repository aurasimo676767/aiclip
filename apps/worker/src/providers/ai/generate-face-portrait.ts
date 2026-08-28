import fsp from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import OpenAI, { toFile } from "openai";

const PHOTOS_ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "../../../assets/streamer-photos");

const PROMPT = `Create a high-quality, photorealistic portrait of the EXACT SAME real person shown in the reference images. This is critical: preserve their real facial features, face shape, hairstyle, eyes, and identity as closely as possible — it must be immediately recognizable as the same specific person, not a generic or different-looking person.

Expression: serious, intense, shocked/surprised reaction — mouth slightly open or tense frown, eyebrows raised, dramatic energy typical of a YouTube reaction thumbnail. NOT smiling, NOT neutral, NOT a webcam-casual look.

Framing: upper body / bust shot, three-quarter or front angle, looking slightly off to the side as if reacting to something happening off-frame.

Style: realistic professional photography, sharp focus, dramatic studio-quality lighting, high detail — NOT a cartoon, NOT an illustration, NOT a webcam screenshot.

Background: fully transparent (isolated subject only, no background elements), so the image can be composited onto another photo.`;

/**
 * Cerca le foto di riferimento reali di uno streamer (assets/streamer-photos/<alias minuscolo>/,
 * NON versionate — dati personali, solo locali) — null se non ce ne sono ancora per questo alias.
 */
export async function hasReferencePhotos(aliasLower: string): Promise<boolean> {
  try {
    const files = await fsp.readdir(path.join(PHOTOS_ROOT, aliasLower));
    return files.some((f) => /\.(jpg|jpeg|png)$/i.test(f));
  } catch {
    return false;
  }
}

/**
 * Genera un ritratto realistico e fedele dello streamer (espressione seria/scioccata, sfondo
 * trasparente) a partire dalle sue foto reali di riferimento, via OpenAI gpt-image-1 — le API di
 * generazione immagini si rifiutano di ricreare persone reali riconoscibili senza una foto
 * fornita da chi ha i diritti sull'immagine, quindi senza foto di riferimento questa funzione
 * non va chiamata (vedi hasReferencePhotos). Costo: circa 15-20 centesimi a generazione (qualità alta).
 */
export async function generateStreamerFacePortrait(params: { apiKey: string; aliasLower: string; outputPath: string }): Promise<void> {
  const photoDir = path.join(PHOTOS_ROOT, params.aliasLower);
  const files = await fsp.readdir(photoDir);
  const imagePaths = files.filter((f) => /\.(jpg|jpeg|png)$/i.test(f)).map((f) => path.join(photoDir, f));
  if (imagePaths.length === 0) {
    throw new Error(`Nessuna foto di riferimento trovata per "${params.aliasLower}" in ${photoDir}`);
  }

  const client = new OpenAI({ apiKey: params.apiKey });
  const result = await client.images.edit({
    model: "gpt-image-1",
    image: await Promise.all(imagePaths.map(async (p) => toFile(await fsp.readFile(p), path.basename(p), { type: "image/jpeg" }))),
    prompt: PROMPT,
    background: "transparent",
    size: "1024x1536",
    quality: "high",
  });

  const b64 = result.data?.[0]?.b64_json;
  if (!b64) {
    throw new Error("OpenAI non ha restituito un'immagine per il ritratto");
  }
  await fsp.mkdir(path.dirname(params.outputPath), { recursive: true });
  await fsp.writeFile(params.outputPath, Buffer.from(b64, "base64"));
}
