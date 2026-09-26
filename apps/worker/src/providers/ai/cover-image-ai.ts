import fsp from "node:fs/promises";
import path from "node:path";
import sharp from "sharp";
import { logger } from "../../lib/logger.js";

/**
 * Rifinitura della copertina con GPT Image (OpenAI), chiesta da simo dopo aver visto le copertine
 * fatte da ChatGPT: la copertina montata da compose-cover.ts fa da BOZZA (impaginazione, facce vere,
 * scritta), e il modello la ridisegna come un grafico: luce, integrazione, scritta nello stile del
 * modello di simo. Le facce arrivano SOLO dalle foto vere della libreria (nomi dati da simo); il
 * prompt chiede di non cambiarle. Chiamata REST diretta: il pacchetto openai installato (4.x) non
 * conosce le immagini multiple dei modelli gpt-image.
 */

export interface AiCoverPerson {
  name: string;
  /** PNG scontornati della libreria, il primo è quello scelto per la copertina. */
  photos: string[];
}

export interface AiCoverParams {
  apiKey: string;
  model: string;
  quality: string;
  kind: "reaction" | "game";
  /** Copertina già montata (compose-cover): impaginazione da tenere. */
  draftPath: string;
  /** Sfondo vero: copertina originale del video reagito o immagine del gioco. */
  backgroundPath: string;
  /** Nell'ordine della bozza: il primo è il protagonista. */
  people: AiCoverPerson[];
  /** Scritta esatta, già in maiuscolo. */
  title: string;
  gameName: string | null;
  /** Copertina modello per lo stile della scritta (assets/cover-style). */
  styleExamplePath: string | null;
  outputPath: string;
}

const OUT_W = 1280;
const OUT_H = 720;

export async function generateAiCover(params: AiCoverParams): Promise<void> {
  const images: Array<{ label: string; path: string }> = [
    { label: "the layout draft", path: params.draftPath },
    { label: "the real background", path: params.backgroundPath },
  ];
  const personLines: string[] = [];
  for (const person of params.people) {
    const first = images.length + 1;
    for (const p of person.photos) images.push({ label: person.name, path: p });
    const last = images.length;
    personLines.push(`- image${first === last ? ` ${first}` : `s ${first}-${last}`}: reference photos of the real person ${person.name}`);
  }
  if (params.styleExamplePath) images.push({ label: "style example", path: params.styleExamplePath });

  const [line1, line2] = splitTitle(params.title);
  const protagonist = params.people[0]?.name;
  const background =
    params.kind === "reaction"
      ? "the thumbnail of the video the streamers are reacting to: keep its scene and people recognizable, but REMOVE its original text and logos"
      : `a real screenshot/artwork of the game${params.gameName ? ` "${params.gameName}"` : ""}: keep it recognizable as that real game, do not invent a different scene`;
  const prompt = [
    "Create a YouTube thumbnail (16:9) for an Italian Twitch clip channel, in the style of the biggest Italian clip channels.",
    "",
    "Input images:",
    "- image 1: rough layout draft. Keep this composition: who is where, their size, the text position.",
    `- image 2: the background, ${background}.`,
    ...personLines,
    ...(params.styleExamplePath ? [`- image ${images.length}: style reference for the TEXT ONLY (font, colors, outline, brush stroke). Do not copy its people or its words.`] : []),
    "",
    "The people are real streamers. Their faces must stay EXACTLY these people: same face shape, eyes, nose, beard, glasses, hairline, skin tone, headphones. Do not beautify, change age, or make them look like someone else. It is better to keep the photo as it is than to change a face.",
    `Make the people huge: head and shoulders rising from the bottom edge, faces big and sharp, with strong exaggerated expressions${protagonist ? `; ${protagonist} is the main character` : ""}. Clean cutout edges with a subtle white outline, lit to match the background.`,
    "",
    line2
      ? `Text: exactly two lines, spelled exactly: first line "${line1}", second line "${line2}". Heavy condensed italic sans-serif (like Anton), very big, bottom center, in front of the people, covering their chests but never their faces. First line white, second line yellow-to-orange gradient, thick black outline, solid drop shadow, a red paint brush stroke behind the second line.`
      : `Text: exactly "${line1}", spelled exactly, one line. Heavy condensed italic sans-serif (like Anton), very big, bottom center, in front of the people, covering their chests but never their faces. Yellow-to-orange gradient, thick black outline, solid drop shadow, a red paint brush stroke behind it.`,
    "No other text, no logos, no watermarks, no borders. Vivid colors, high contrast, very sharp.",
  ].join("\n");

  const form = new FormData();
  form.append("model", params.model);
  form.append("prompt", prompt);
  form.append("size", "1536x864");
  form.append("quality", params.quality);
  form.append("output_format", "png");
  form.append("n", "1");
  for (const img of images) {
    const buffer = await fsp.readFile(img.path);
    const type = img.path.toLowerCase().endsWith(".png") ? "image/png" : "image/jpeg";
    form.append("image[]", new Blob([buffer], { type }), path.basename(img.path));
  }

  const started = Date.now();
  const res = await fetch("https://api.openai.com/v1/images/edits", {
    method: "POST",
    headers: { Authorization: `Bearer ${params.apiKey}` },
    body: form,
    signal: AbortSignal.timeout(300_000),
  });
  const body = (await res.json()) as {
    data?: Array<{ b64_json?: string }>;
    usage?: unknown;
    error?: { message?: string; code?: string };
  };
  if (!res.ok || !body.data?.[0]?.b64_json) {
    throw new Error(`GPT Image ${res.status}: ${body.error?.message ?? "nessuna immagine"}`);
  }
  await sharp(Buffer.from(body.data[0].b64_json, "base64"))
    .resize(OUT_W, OUT_H, { fit: "cover" })
    .jpeg({ quality: 92 })
    .toFile(params.outputPath);
  logger.info("Copertina rifinita con GPT Image", {
    model: params.model,
    quality: params.quality,
    immagini: images.length,
    secondi: Math.round((Date.now() - started) / 1000),
    usage: body.usage,
  });
}

/** Le stesse due righe della bozza (compose-cover divide allo stesso modo). */
function splitTitle(text: string): [string, string | undefined] {
  const words = text.trim().split(/\s+/);
  if (words.length <= 1 || text.length <= 12) return [text, undefined];
  let best: [string, string] = [words[0]!, words.slice(1).join(" ")];
  let bestDiff = Infinity;
  for (let i = 1; i < words.length; i++) {
    const a = words.slice(0, i).join(" ");
    const b = words.slice(i).join(" ");
    const diff = Math.abs(a.length - b.length);
    if (diff < bestDiff) {
      bestDiff = diff;
      best = [a, b];
    }
  }
  return best;
}
