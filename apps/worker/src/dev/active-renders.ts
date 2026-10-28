import "dotenv/config";
import { supabase } from "../lib/supabase.js";

/** Render in coda o in corso, con la clip. Uso: tsx src/dev/active-renders.ts */
const { data } = await supabase.from("render_jobs").select("id,clip_id,status,created_at").in("status", ["PENDING", "RENDERING"]);
for (const j of data ?? []) {
  const { data: clip } = await supabase.from("clips").select("title,duration,longform_edit").eq("id", j.clip_id).single();
  console.log(j.id, j.clip_id, j.status, Math.round((clip?.duration ?? 0) / 60) + "min", clip?.longform_edit ? "montato" : "", clip?.title);
}
