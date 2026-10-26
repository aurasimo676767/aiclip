import "dotenv/config";
import { supabase } from "../lib/supabase.js";

/**
 * Elenca i render in coda o in corso (gratis, sola lettura), con la clip e il video da cui vengono.
 * Uso: tsx src/dev/list-active-renders.ts [--since=ISO] (con --since mostra anche i completati da allora)
 */
const since = process.argv.find((a) => a.startsWith("--since="))?.slice(8);
const statuses = since ? (["PENDING", "RENDERING", "COMPLETED"] as const) : (["PENDING", "RENDERING"] as const);
let query = supabase
  .from("render_jobs")
  .select("id, status, clip_id, created_at, clips(id, title, video_id, status, duration)")
  .in("status", statuses)
  .order("created_at", { ascending: true });
if (since) query = query.gte("created_at", since);
const { data, error } = await query;
if (error) throw error;
for (const job of data ?? []) {
  const clip = job.clips as unknown as { title: string | null; video_id: string; duration: number | null } | null;
  console.log(`${job.status.padEnd(9)} clip=${job.clip_id} video=${clip?.video_id} ${Math.round(clip?.duration ?? 0)}s "${clip?.title ?? ""}"`);
}
console.log(`totale: ${data?.length ?? 0}`);
