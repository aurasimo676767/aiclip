import "dotenv/config";
import { supabase } from "../lib/supabase.js";

/** Render job di una clip, dal più recente. Uso: tsx src/dev/clip-renders.ts <clipId> */
const { data } = await supabase.from("render_jobs").select("*").eq("clip_id", process.argv[2]!).order("created_at", { ascending: false }).limit(5);
for (const j of data ?? []) {
  const r = j as Record<string, unknown>;
  console.log(JSON.stringify({ id: r.id, status: r.status, created: r.created_at, started: r.started_at, completed: r.completed_at, stage: r.stage, error: r.error_message }));
}
