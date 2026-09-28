import "dotenv/config";
import { supabase } from "../lib/supabase.js";

/** Shorts pubblicati negli ultimi giorni con orario e visualizzazioni (dall'ultimo aggiornamento). Uso: tsx src/dev/shorts-by-day.ts [giorni] */
const days = Number(process.argv[2] ?? 7);
const since = new Date(Date.now() - days * 86400000).toISOString();
const { data } = await supabase.from("youtube_publish_jobs").select("*").eq("status", "COMPLETED").is("cancelled_at", null).gte("created_at", since).order("created_at");
for (const j of data ?? []) {
  const r = j as Record<string, unknown>;
  const { data: clip } = await supabase.from("clips").select("title,format,duration,updated_at").eq("id", r.clip_id as string).single();
  if (clip?.format !== "short") continue;
  const when = (r.publish_at as string | null) ?? (r.completed_at as string);
  console.log(`${when?.slice(5, 16).replace("T", " ")}  views ${String(r.view_count ?? "?").padStart(5)}  ${Math.round(clip.duration)}s  ${clip.title?.slice(0, 55)}`);
}
