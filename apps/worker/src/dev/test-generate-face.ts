import fsp from "node:fs/promises";
import path from "node:path";
import OpenAI, { toFile } from "openai";
import { env } from "../env.js";

const photoDir = process.argv[2] ?? "assets/streamer-photos/blur";
const outputPath = process.argv[3] ?? "tmp/generated-face.png";

const files = await fsp.readdir(photoDir);
const imagePaths = files.filter((f) => /\.(jpg|jpeg|png)$/i.test(f)).map((f) => path.join(photoDir, f));
console.log("Foto di riferimento:", imagePaths);

const client = new OpenAI({ apiKey: env.OPENAI_API_KEY });

const prompt = `Create a high-quality, photorealistic portrait of the EXACT SAME real person shown in the reference images. This is critical: preserve their real facial features, face shape, hairstyle, eyes, and identity as closely as possible — it must be immediately recognizable as the same specific person, not a generic or different-looking person.

Expression: serious, intense, shocked/surprised reaction — mouth slightly open or tense frown, eyebrows raised, dramatic energy typical of a YouTube reaction thumbnail. NOT smiling, NOT neutral, NOT a webcam-casual look.

Framing: upper body / bust shot, three-quarter or front angle, looking slightly off to the side as if reacting to something happening off-frame.

Style: realistic professional photography, sharp focus, dramatic studio-quality lighting, high detail — NOT a cartoon, NOT an illustration, NOT a webcam screenshot.

Background: fully transparent (isolated subject only, no background elements), so the image can be composited onto another photo.`;

const result = await client.images.edit({
  model: "gpt-image-1",
  image: await Promise.all(imagePaths.map(async (p) => await toFile(await fsp.readFile(p), path.basename(p), { type: "image/jpeg" }))),
  prompt,
  background: "transparent",
  size: "1024x1536",
  quality: "high",
});

const b64 = result.data?.[0]?.b64_json;
if (!b64) {
  console.error("Nessuna immagine restituita:", JSON.stringify(result, null, 2));
  process.exit(1);
}
await fsp.mkdir(path.dirname(outputPath), { recursive: true });
await fsp.writeFile(outputPath, Buffer.from(b64, "base64"));
console.log("scritto", outputPath);
