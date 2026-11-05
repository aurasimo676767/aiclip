import "dotenv/config";
import { supabase } from "../lib/supabase.js";

/**
 * Fa renderizzare per prima una clip in coda: il worker prende i render in ordine di created_at
 * (claim_next_render_job), quindi si anticipa il suo. Quello già in corso finisce prima.
 * Uso: tsx src/dev/prioritize-render.ts <clipId> [<clipId>...]  (il primo passa davanti a tutti)
 */
const clipIds = process.argv.slice(2);
const { data: oldest } = await supabase.from("render_jobs").select("created_at").eq("status", "PENDING").order("created_at").limit(1).maybeSingle();
const base = new Date(oldest?.created_at ?? Date.now()).getTime() - 60_000 * (clipIds.length + 1);
for (const [i, clipId] of clipIds.entries()) {
  const { data, error } = await supabase
    .from("render_jobs")
    .update({ created_at: new Date(base + i * 60_000).toISOString() })
    .eq("clip_id", clipId)
    .eq("status", "PENDING")
    .select("id");
  if (error) throw new Error(error.message);
  console.log(data?.length ? `${clipId}: in testa alla coda (posto ${i + 1})` : `${clipId}: nessun render in attesa`);
}
const { data: running } = await supabase.from("render_jobs").select("clip_id,stage,progress").eq("status", "RENDERING");
for (const r of running ?? []) {
  const { data: clip } = await supabase.from("clips").select("title,start_time,end_time").eq("id", r.clip_id).single();
  console.log(`In corso adesso: ${clip?.title} (${Math.round(((clip?.end_time ?? 0) - (clip?.start_time ?? 0)) / 60)} min) ${r.stage ?? ""} ${r.progress ?? ""}%`);
}
