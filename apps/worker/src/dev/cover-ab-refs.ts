import "dotenv/config";
import fsp from "node:fs/promises";
import path from "node:path";
import { supabase } from "../lib/supabase.js";
import { readFaceLibrary } from "../lib/face-library.js";
import { pickFaces, downloadFaces, findSteamHero, findSteamLogo, PERSON_STYLE } from "../pipeline/cover-builder.js";
import { bestHeadCrops } from "../pipeline/face-reference.js";
import { generateAiCover } from "../providers/ai/cover-image-ai.js";
import { composeCover, COVER_THEMES } from "../render/compose-cover.js";
import { env } from "../env.js";

/**
 * Prova A/B delle foto di riferimento (A PAGAMENTO, ~0,15 $): stessa bozza, stesso prompt, una volta
 * con 5 primi piani da 768 px e una con 4 da 512 px, per vedere se rimpicciolirli toglie somiglianza.
 * Uso: tsx src/dev/cover-ab-refs.ts <cartella> <NOME> <gioco steam> "<SCRITTA>"
 */
const [dir, name, game, title] = process.argv.slice(2);
await fsp.mkdir(dir!, { recursive: true });
const { data: profile } = await supabase.from("profiles").select("id").limit(1).single();
const library = await readFaceLibrary(profile!.id, dir!);
const faces = pickFaces(library, [name!], null, 1, "game");
const facePaths = await downloadFaces(faces, dir!);
const background = await findSteamHero(game!, path.join(dir!, "bg.jpg"));
if (!background) throw new Error("sfondo non trovato");
const draft = path.join(dir!, "draft.jpg");
await composeCover({ backgroundPath: background, kind: "game", faces: facePaths, title: title!, theme: COVER_THEMES.giallo!, outputPath: draft });
const logo = await findSteamLogo(game!, path.join(dir!, "logo.png"));
const style = path.resolve("assets", "cover-style", "modello-scritta.jpg");
for (const [label, n, size] of [["A-5x768", 5, 768], ["B-4x512", 4, 512]] as const) {
  const crops = await bestHeadCrops(library, name!, n, dir!, size);
  await generateAiCover({
    apiKey: env.OPENAI_API_KEY,
    model: env.COVER_AI_MODEL,
    quality: env.COVER_AI_QUALITY,
    kind: "game",
    draftPath: draft,
    backgroundPath: background,
    people: [{ name: name!, photos: crops.map((c) => c.path), styleNote: PERSON_STYLE[name!]?.note }],
    title: title!,
    gameName: game!,
    styleExamplePath: style,
    logoPath: logo,
    outputPath: path.join(dir!, `${label}.jpg`),
  });
  console.log("fatto", label);
}
