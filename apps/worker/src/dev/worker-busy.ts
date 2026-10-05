import "dotenv/config";
import { supabase } from "../lib/supabase.js";

/**
 * Il worker sta facendo qualcosa che un riavvio interromperebbe? (tsx watch lo riavvia a ogni
 * modifica di un file che importa.) Conta solo i lavori GIÀ PARTITI: quelli in coda ripartono da
 * soli dopo il riavvio. Stampa una riga JSON {busy, reasons}. Usato dalla sicura in
 * .claude/hooks/guard.mjs. Uso: tsx src/dev/worker-busy.ts
 */
const checks: Array<[string, string, string[]]> = [
  ["videos", "video in lavorazione", ["DOWNLOADING", "EXTRACTING_AUDIO", "TRANSCRIBING", "ANALYZING", "CLIP_SELECTION"]],
  ["render_jobs", "render in corso", ["RENDERING"]],
  ["youtube_publish_jobs", "caricamenti su YouTube in corso", ["UPLOADING"]],
  ["tiktok_publish_jobs", "pubblicazioni TikTok in corso", ["UPLOADING", "PROCESSING"]],
  ["thumbnail_jobs", "copertine in corso", ["PROCESSING"]],
  ["voiceover_jobs", "voice over in corso", ["RENDERING"]],
];

const reasons: string[] = [];
for (const [table, label, statuses] of checks) {
  const { count, error } = await supabase
    .from(table as "videos")
    .select("id", { count: "exact", head: true })
    .in("status", statuses as never[]);
  if (error) throw new Error(`${table}: ${error.message}`);
  if ((count ?? 0) > 0) reasons.push(`${count} ${label}`);
}
console.log(JSON.stringify({ busy: reasons.length > 0, reasons }));
