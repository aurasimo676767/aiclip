import "dotenv/config";
import fs from "node:fs";
import path from "node:path";
import { supabase } from "../lib/supabase.js";

/**
 * Toglie dal sito una clip doppione (es. un pezzo di video finito dentro un altro). Prima salva la
 * riga in tmp/removed-clips/<id>.json per poterla rimettere; il file renderizzato resta su R2.
 * Rifiuta le clip pubblicate, in lavorazione o con copertine.
 * Uso: tsx src/dev/remove-clip.ts <clipId>
 */
const clipId = process.argv[2]!;
const { data: clip } = await supabase.from("clips").select("*").eq("id", clipId).single();
if (!clip) throw new Error("Clip non trovata");
if (clip.status === "QUEUED" || clip.status === "RENDERING") throw new Error("Clip in lavorazione");
const { data: yt } = await supabase.from("youtube_publish_jobs").select("id").eq("clip_id", clipId);
const { data: tt } = await supabase.from("tiktok_publish_jobs").select("id").eq("clip_id", clipId);
const { data: covers } = await supabase.from("thumbnail_jobs").select("id").eq("clip_id", clipId);
if (yt?.length || tt?.length) throw new Error("La clip ha pubblicazioni: non la tolgo");
if (covers?.length) throw new Error("La clip ha copertine: non la tolgo");
const { data: renders } = await supabase.from("render_jobs").select("*").eq("clip_id", clipId);
const dir = path.join("tmp", "removed-clips");
fs.mkdirSync(dir, { recursive: true });
fs.writeFileSync(path.join(dir, `${clipId}.json`), JSON.stringify({ clip, renders }, null, 1));
const { error } = await supabase.from("clips").delete().eq("id", clipId);
if (error) throw new Error(error.message);
console.log(`Tolta "${clip.title}" (${clipId}), copia in ${path.join(dir, `${clipId}.json`)}`);
