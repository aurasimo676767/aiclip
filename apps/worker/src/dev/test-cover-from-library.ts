import "dotenv/config";
import fsp from "node:fs/promises";
import path from "node:path";
import { supabase } from "../lib/supabase.js";
import { readFaceLibrary } from "../lib/face-library.js";
import { pickFaces, downloadFaces, findSteamHero, referenceFaces } from "../pipeline/cover-builder.js";
import { generateAiCover } from "../providers/ai/cover-image-ai.js";
import { env } from "../env.js";
import { composeCover, COVER_THEMES } from "../render/compose-cover.js";

/**
 * Copertina di prova con le facce VERE della libreria (solo quelle col nome), come la fa il job:
 * stessa scelta delle facce, stesso compositore. Sfondo: file locale oppure "steam:<gioco>".
 * Uso: tsx src/dev/test-cover-from-library.ts <out.jpg> <reaction|game> <sfondo> "<SCRITTA>" <colore> <espressione> <NOME> [NOME...]
 * AI=1 dopo la bozza la fa rifinire a GPT Image (A PAGAMENTO, ~5-10 centesimi): esce <out>-ai.jpg.
 * FACE_IDS=<id>,<id> (anche solo l'inizio dell'id) forza le facce invece di sceglierle.
 */
const [out, kind, bgArg, title, color, expression, ...people] = process.argv.slice(2);
const work = path.join(path.dirname(path.resolve(out!)), "cover-work");
await fsp.mkdir(work, { recursive: true });
const { data: profile } = await supabase.from("profiles").select("id").limit(1).single();
const library = await readFaceLibrary(profile!.id, work);
const forced = process.env.FACE_IDS?.split(",");
const faces = forced ? forced.map((id) => library.faces.find((f) => f.id.startsWith(id))!) : pickFaces(library, people.map((p) => p.toUpperCase()), expression ?? null, kind === "reaction" ? 2 : 4, kind as "reaction" | "game");
const facePaths = await downloadFaces(faces, work);
const background = bgArg!.startsWith("steam:") ? await findSteamHero(bgArg!.slice(6), path.join(work, "steam.jpg")) : bgArg!;
if (!background) throw new Error("Sfondo non trovato");
await composeCover({ backgroundPath: background, kind: kind as "reaction" | "game", faces: facePaths, title: title!, theme: COVER_THEMES[color!] ?? COVER_THEMES.giallo!, outputPath: path.resolve(out!) });
console.log("ok", out, faces.map((f) => `${f.label}:${f.expression}:${f.intensity}:${f.id.slice(0, 8)}`).join(" "));
if (process.env.AI === "1") {
  const people = [];
  for (const f of faces) people.push({ name: f.label ?? "", photos: await downloadFaces(referenceFaces(library, f, 2), work) });
  const aiOut = path.resolve(out!).replace(/.jpg$/i, "") + "-ai.jpg";
  const style = path.resolve("assets", "cover-style", "modello-scritta.jpg");
  await generateAiCover({
    apiKey: env.OPENAI_API_KEY,
    model: env.COVER_AI_MODEL === "off" ? "gpt-image-2.5-sunburst" : env.COVER_AI_MODEL,
    quality: env.COVER_AI_QUALITY,
    kind: kind as "reaction" | "game",
    draftPath: path.resolve(out!),
    backgroundPath: background,
    people,
    title: title!.toUpperCase(),
    gameName: bgArg!.startsWith("steam:") ? bgArg!.slice(6) : null,
    styleExamplePath: await fsp.access(style).then(() => style, () => null),
    outputPath: aiOut,
  });
  console.log("ai", aiOut);
}
