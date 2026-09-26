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
  /** Come deve apparire sempre (es. Blur col cappello Red Bull), vedi PERSON_STYLE. */
  styleNote?: string;
}

export interface AiCoverParams {
  apiKey: string;
  model: string;
  quality: string;
  /** "short" = copertina verticale 9:16 di uno Short; le altre sono 16:9. */
  kind: "reaction" | "game" | "short";
  /** Copertina già montata (compose-cover): impaginazione da tenere. Gli Short non ce l'hanno. */
  draftPath: string | null;
  /** Sfondo vero: copertina originale del video reagito, immagine del gioco o fotogramma dello Short. */
  backgroundPath: string;
  /** Nell'ordine della bozza: il primo è il protagonista. */
  people: AiCoverPerson[];
  /** Scritta esatta, già in maiuscolo. */
  title: string;
  gameName: string | null;
  /** Espressione/atmosfera voluta (es. dall'AI che sceglie la copertina); senza, una di default per tipo. */
  mood?: string;
  /** Copertina modello per lo stile della scritta (assets/cover-style). */
  styleExamplePath: string | null;
  outputPath: string;
}

export async function generateAiCover(params: AiCoverParams): Promise<void> {
  const vertical = params.kind === "short";
  const images: Array<{ path: string; textBandOnly?: boolean }> = [];
  const add = (imagePath: string, textBandOnly = false) => {
    images.push({ path: imagePath, textBandOnly });
    return images.length;
  };
  const inputLines: string[] = [];
  if (params.draftPath) {
    const n = add(params.draftPath);
    inputLines.push(
      `- image ${n}: rough layout draft. Use it ONLY for the composition: who is where, their size, the text position. Do NOT copy the people's poses, hands, clothes or expressions from it.`,
    );
  }
  const bgIndex = add(params.backgroundPath);
  const background =
    params.kind === "reaction"
      ? "the thumbnail of the video the streamers are reacting to: keep its scene and people recognizable, but REMOVE its original text and logos"
      : params.kind === "game"
        ? `a real screenshot/artwork of the game${params.gameName ? ` "${params.gameName}"` : ""}: keep it recognizable as that real game, do not invent a different scene`
        : "a frame of the Short clip itself (the key moment): use what happens in it as the scene behind the streamer (for a reaction to a TikTok or video, show that video behind; for a game, the game)";
  inputLines.push(`- image ${bgIndex}: the background, ${background}.`);
  for (const person of params.people) {
    const first = images.length + 1;
    for (const p of person.photos) add(p);
    const last = images.length;
    inputLines.push(
      (first === last
        ? `- image ${first}: reference photo of the real streamer nicknamed "${person.name}"`
        : `- images ${first}-${last}: ${last - first + 1} different photos of the SAME single streamer, nicknamed "${person.name}" (draw them only once)`) +
        (person.styleNote ? `. In the thumbnail "${person.name}" is ${person.styleNote}.` : ""),
    );
  }
  // Solo la striscia bassa con la scritta: dall'esempio intero GPT copiava anche le persone (Marza
  // spuntava in una copertina dove doveva esserci solo Blur).
  if (params.styleExamplePath) {
    const n = add(params.styleExamplePath, true);
    inputLines.push(`- image ${n}: style reference for the TEXT ONLY (font, colors, outline, brush stroke). Do not copy its words or anything else from it.`);
  }

  const [line1, line2] = splitTitle(params.title, vertical ? 9 : 12);
  const protagonist = params.people[0]?.name;
  const textPlace = vertical
    ? "very big, over the streamer's chest in the lower-middle part of the frame, in front of him, never covering the face; keep it inside the central area (the Shorts shelf crops the edges)"
    : "very big, bottom center, in front of the people, covering their chests but never their faces";
  // Modello di simo per gli Short (2026-09-26): la persona in primo piano grande, dietro quello a cui
  // reagisce o il momento della clip, scritta enorme che dice di cosa si tratta.
  const layout = vertical
    ? "Vertical 9:16 layout like the big Italian Shorts channels: the streamer very big in the foreground, from the chest up, face in the upper-middle of the frame looking at the camera or at what happens; behind him what the clip is about (the reacted TikTok/video, the funny moment, the game), or a simple bright background if the clip is just him talking. Keep face and text inside the central 3:4 area: the Shorts shelf crops the top and bottom."
    : "Make the people huge: head and shoulders rising from the bottom edge, faces big and sharp.";
  const mood =
    params.mood ??
    (params.kind === "reaction"
      ? "watching and reacting to the video: curious, amused or surprised, relaxed natural pose"
      : params.kind === "game"
        ? "playing the game with friends: hyped, shocked or laughing, strong exaggerated expressions"
        : "reacting to the key moment of the clip (laughing, shocked, disgusted...): a strong, readable expression that matches it");
  const prompt = [
    vertical
      ? "Create a vertical 9:16 YouTube Shorts cover for an Italian Twitch clip channel, in the style of the biggest Italian clip channels."
      : "Create a YouTube thumbnail (16:9) for an Italian Twitch clip channel, in the style of the biggest Italian clip channels.",
    "",
    "Input images:",
    ...inputLines,
    "",
    // "Blur" preso alla lettera: la faccia di Blur usciva sfocata.
    `Names like "Blur" are only nicknames: never blur, soften or hide anyone; every face must be perfectly sharp and in focus.`,
    "The people are real streamers. Their faces must stay EXACTLY these people: same face shape, eyes, nose, beard, glasses, hairline, skin tone. Do not beautify, change age, or make them look like someone else.",
    // simo (2026-09-26): Blur usciva sempre con la stessa foto e la sciarpa blu, che nel tour della
    // casa di Murri "non ha senso". Le foto servono solo per il volto: posa, vestiti ed espressione
    // li decide il modello in base al video.
    "Use the reference photos ONLY to know what each face looks like (plus any fixed style written above). Do NOT copy a single photo: create a NEW natural pose and expression for each person, and do not reuse clothes or accessories (scarves, jerseys, props) that don't fit this video; plain streamer clothes (t-shirt or hoodie, gaming headphones) are fine. Hands and arms must be anatomically realistic, or keep them out of the frame.",
    // Con 3 foto della stessa persona GPT disegnava tre ragazzi diversi (copertina di Murri, 2026-09-26).
    params.people.length > 0
      ? `Exactly ${params.people.length} streamer${params.people.length === 1 ? "" : "s"} in the foreground, each drawn ONCE: ${params.people.map((p) => `"${p.name}"`).join(", ")}. Never duplicate a person and never add other streamers.${params.draftPath ? " If someone is missing from the draft, add them next to the others, same size and style." : ""}`
      : `No reference photos: the streamer in the foreground is the person already visible in image ${bgIndex}, redrawn big and sharp with the SAME face; never invent a different person.`,
    ...(params.kind === "reaction"
      ? [`Keep the main person or subject of the original thumbnail (image ${bgIndex}) clearly visible in the background: it is what the streamers are reacting to.`]
      : []),
    `${layout}${protagonist ? ` "${protagonist}" is the main character.` : ""} Mood: ${mood}. Clean cutout edges with a subtle white outline, lit to match the background.`,
    "",
    line2
      ? `Text: exactly two lines, spelled exactly: first line "${line1}", second line "${line2}". Heavy condensed italic sans-serif (like Anton), ${textPlace}. First line white, second line ${vertical ? "bright red or yellow-to-orange, whichever reads best on the background" : "yellow-to-orange gradient"}, thick black outline, solid drop shadow${vertical ? "" : ", a red paint brush stroke behind the second line"}.`
      : `Text: exactly "${line1}", spelled exactly, one line. Heavy condensed italic sans-serif (like Anton), ${textPlace}. Yellow-to-orange gradient, thick black outline, solid drop shadow, a red paint brush stroke behind it.`,
    "No other text, no logos, no watermarks, no borders. Vivid colors, high contrast, very sharp.",
  ].join("\n");

  const form = new FormData();
  form.append("model", params.model);
  form.append("prompt", prompt);
  form.append("size", vertical ? "864x1536" : "1536x864");
  form.append("quality", params.quality);
  form.append("output_format", "png");
  form.append("n", "1");
  for (const img of images) {
    let buffer: Buffer = await fsp.readFile(img.path);
    if (img.textBandOnly) {
      const { width = 0, height = 0 } = await sharp(buffer).metadata();
      const top = Math.round(height * 0.6);
      buffer = await sharp(buffer).extract({ left: 0, top, width, height: height - top }).jpeg({ quality: 92 }).toBuffer();
    }
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
    .resize(vertical ? 1080 : 1280, vertical ? 1920 : 720, { fit: "cover" })
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

/** Le stesse due righe della bozza (compose-cover divide allo stesso modo); in verticale si va a capo prima. */
function splitTitle(text: string, oneLineMax: number): [string, string | undefined] {
  const words = text.trim().split(/\s+/);
  if (words.length <= 1 || text.length <= oneLineMax) return [text, undefined];
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
