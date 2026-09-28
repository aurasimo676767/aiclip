import "dotenv/config";
import { supabase } from "../lib/supabase.js";

/** Ultime pubblicazioni YouTube con stato, privacy, orario programmato e statistiche. Uso: tsx src/dev/recent-yt-publishes.ts [n] */
const n = Number(process.argv[2] ?? 6);
const { data } = await supabase.from("youtube_publish_jobs").select("*").order("created_at", { ascending: false }).limit(n);
for (const j of data ?? []) {
  const r = j as Record<string, unknown>;
  const { data: clip } = await supabase.from("clips").select("title,format").eq("id", r.clip_id as string).single();
  console.log(JSON.stringify({ titolo: clip?.title, formato: clip?.format, stato: r.status, privacy: r.privacy_status, programmatoPer: r.publish_at, completato: r.completed_at, url: r.youtube_url, annullato: r.cancelled_at, views: r.view_count ?? r.views ?? null }));
}
