import "dotenv/config";
import { supabase } from "../lib/supabase.js";
import { ensureLongformGames, gamesToKeep } from "../pipeline/longform-games.js";

/**
 * Riconosce i giochi di una clip long-form dallo schermo e li salva (A PAGAMENTO, ~2-3 centesimi
 * per un'ora: chiedere a simo). Serve il sorgente in locale.
 * Uso: tsx src/dev/detect-games.ts <clipId> <sorgente locale>
 */
const [clipId, source] = process.argv.slice(2);
const { data: clip, error } = await supabase.from("clips").select("*").eq("id", clipId!).single();
if (error || !clip) throw new Error(`Clip non trovata: ${error?.message}`);
const timeline = await ensureLongformGames({ ...clip, longform_games: null }, source!);
if (!timeline) throw new Error("Riconoscimento fallito");
for (const s of timeline) console.log(`${(s.start / 60).toFixed(2)}-${(s.end / 60).toFixed(2)} min  ${s.kind}  ${s.name}${s.what ? ` (${s.what})` : ""}`);
console.log("Da tenere di default:", gamesToKeep(timeline, (clip as { longform_keep_games?: unknown }).longform_keep_games));
