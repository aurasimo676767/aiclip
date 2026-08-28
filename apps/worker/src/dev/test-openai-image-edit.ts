import fsp from "node:fs/promises";
import OpenAI from "openai";
import { env } from "../env.js";

const facePath = process.argv[2];
const scenePath = process.argv[3];
const stylePath = process.argv[4];
if (!facePath || !scenePath || !stylePath) {
  console.error("Uso: tsx src/dev/test-openai-image-edit.ts <faccia.jpg> <scena.jpg> <riferimento-stile.jpg>");
  process.exit(1);
}

const client = new OpenAI({ apiKey: env.OPENAI_API_KEY });

const prompt = `Crea una copertina YouTube professionale in stile "reaction", seguendo ESATTAMENTE lo stile grafico dell'immagine di riferimento (font grosso e bold, testo con contorno spesso e ombra, colori vivaci, layout dinamico non perfettamente centrato, tanta energia). Usa la persona dell'immagine 1 (mantieni la sua identità/faccia reale il più possibile fedele) con un'espressione seria/scioccata, posizionata sulla destra. Usa la scena dell'immagine 2 come sfondo/contenuto principale. Scritta grande in stile fumettistico: "PAGA 7.000€ A NOTTE?" con colori ad alto contrasto (rosso/giallo/bianco), non testo semplice bianco centrato. Formato 16:9, altissima qualità, stile fotografico realistico non cartoon.`;

const result = await client.images.edit({
  model: "gpt-image-1",
  image: [
    await fsp.readFile(facePath).then((b) => new File([b], "face.jpg", { type: "image/jpeg" })),
    await fsp.readFile(scenePath).then((b) => new File([b], "scene.jpg", { type: "image/jpeg" })),
    await fsp.readFile(stylePath).then((b) => new File([b], "style.jpg", { type: "image/jpeg" })),
  ],
  prompt,
  size: "1536x1024",
  quality: "high",
});

const b64 = result.data?.[0]?.b64_json;
if (!b64) {
  console.error("Nessuna immagine restituita:", JSON.stringify(result, null, 2));
  process.exit(1);
}
await fsp.mkdir("tmp", { recursive: true });
await fsp.writeFile("tmp/openai-thumbnail-test.png", Buffer.from(b64, "base64"));
console.log("scritto tmp/openai-thumbnail-test.png");
