/** Aggiorna subito le statistiche YouTube (come il loop del worker) e stampa gli ultimi video pubblicati. Uso: tsx src/dev/refresh-stats-now.ts */
import "dotenv/config";
import { supabase } from "../lib/supabase.js";
import { refreshYoutubeStats } from "../pipeline/refresh-youtube-stats.js";
await refreshYoutubeStats();
const { data } = await supabase.from("youtube_publish_jobs").select("view_count,analytics_views,engaged_views,avg_view_duration,avg_view_percentage,share_count,subscribers_gained,analytics_error,clips(title,format)").eq("status", "COMPLETED").not("youtube_video_id", "is", null).order("completed_at", { ascending: false }).limit(12);
for (const j of data ?? []) {
  const c: any = Array.isArray(j.clips) ? j.clips[0] : j.clips;
  const stayed = j.analytics_views ? Math.round((j.engaged_views! / j.analytics_views) * 100) + "%" : "—";
  console.log(`${c?.format} | views ${j.view_count} | restano ${stayed} | guardato ${Math.round(j.avg_view_duration ?? 0)}s (${Math.round(j.avg_view_percentage ?? 0)}%) | cond ${j.share_count} | iscr ${j.subscribers_gained} | ${j.analytics_error ?? ""} | ${c?.title?.slice(0, 45)}`);
}
