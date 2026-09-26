import "dotenv/config";
import fsp from "node:fs/promises";
import path from "node:path";
import { supabase } from "../lib/supabase.js";
import { readFaceLibrary } from "../lib/face-library.js";
import { pickFaces, downloadFaces, findSteamHero } from "../pipeline/cover-builder.js";
import { composeCover, COVER_THEMES } from "../render/compose-cover.js";

/**
 * Copertina di prova con le facce VERE della libreria (solo quelle col nome), come la fa il job:
 * stessa scelta delle facce, stesso compositore. Sfondo: file locale oppure "steam:<gioco>".
 * Uso: tsx src/dev/test-cover-from-library.ts <out.jpg> <reaction|game> <sfondo> "<SCRITTA>" <colore> <espressione> <NOME> [NOME...]
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
