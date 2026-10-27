import "dotenv/config";
import { supabase } from "../lib/supabase.js";

/** Quanto lavoro fa il worker al giorno (video, clip, copertine), per stimare i costi al mese. Uso: tsx src/dev/volume-stats.ts [giorni] */
const days = Number(process.argv[2] ?? 10);
const since = new Date(Date.now() - days * 86400_000).toISOString();
const count = (rows: { created_at: string }[], key: (r: never) => string) => {
  const out: Record<string, number> = {};
  for (const r of rows) {
    const k = `${r.created_at.slice(0, 10)} ${key(r as never)}`;
    out[k] = (out[k] ?? 0) + 1;
  }
  return Object.entries(out).sort();
};
const { data: videos } = await supabase.from("videos").select("*").gte("created_at", since);
const { data: clips } = await supabase.from("clips").select("*").gte("created_at", since);
const { data: covers } = await supabase.from("thumbnail_jobs").select("created_at,status,cover_instructions").gte("created_at", since);


for (const [k, n] of count(videos ?? [], (v: { source_type?: string; duration_seconds?: number }) => `video ${v.source_type ?? ""} ${Math.round((v.duration_seconds ?? 0) / 60)}min`)) console.log(k, n);
for (const [k, n] of count(clips ?? [], (c: { format?: string; longform_edit?: boolean }) => `clip ${c.format ?? "?"}${c.longform_edit ? " montato" : ""}`)) console.log(k, n);
for (const [k, n] of count(covers ?? [], (j: { status: string; cover_instructions: string | null }) => `copertina ${j.cover_instructions?.startsWith("[modifica:") ? "modifica" : "nuova"} ${j.status}`)) console.log(k, n);
