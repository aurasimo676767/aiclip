import { env } from "../env.js";
import { logger } from "../lib/logger.js";
import { supabase } from "../lib/supabase.js";
import { fetchYoutubeVideoStats } from "../providers/youtube/youtube-stats.js";

/**
 * Aggiorna periodicamente views/like/commenti dei video già pubblicati su YouTube, salvandoli
 * in DB invece di leggerli live ad ogni apertura della pagina "Pubblicati" — vedi index.ts per
 * la cadenza del loop. Un video "programmato" (privato in attesa della data) ha comunque un
 * youtube_video_id (l'upload avviene subito, solo la visibilità è differita da YouTube stessa),
 * quindi rientra qui senza bisogno di distinguere i due casi: le statistiche saranno solo 0
 * finché non diventa pubblico.
 */
export async function refreshYoutubeStats(): Promise<void> {
  const { data: jobs, error: jobsError } = await supabase
    .from("youtube_publish_jobs")
    .select("id, clip_id, youtube_video_id")
    .eq("status", "COMPLETED")
    .not("youtube_video_id", "is", null);
  if (jobsError) {
    logger.error("Lettura job di pubblicazione per refresh statistiche fallita", { error: jobsError.message });
    return;
  }
  if (!jobs || jobs.length === 0) return;

  const clipIds = [...new Set(jobs.map((j) => j.clip_id))];
  const { data: clips, error: clipsError } = await supabase.from("clips").select("id, project_id").in("id", clipIds);
  if (clipsError) {
    logger.error("Lettura clip per refresh statistiche fallita", { error: clipsError.message });
    return;
  }
  const projectIdByClip = new Map((clips ?? []).map((c) => [c.id, c.project_id]));

  const projectIds = [...new Set([...projectIdByClip.values()])];
  const { data: projects, error: projectsError } = await supabase.from("projects").select("id, user_id").in("id", projectIds);
  if (projectsError) {
    logger.error("Lettura progetti per refresh statistiche fallita", { error: projectsError.message });
    return;
  }
  const userIdByProject = new Map((projects ?? []).map((p) => [p.id, p.user_id]));

  // Raggruppa i job per utente (ognuno usa la propria connessione YouTube per leggere le sue statistiche).
  const jobsByUser = new Map<string, { id: string; youtube_video_id: string }[]>();
  for (const job of jobs) {
    if (!job.youtube_video_id) continue;
    const projectId = projectIdByClip.get(job.clip_id);
    const userId = projectId ? userIdByProject.get(projectId) : undefined;
    if (!userId) continue;
    const list = jobsByUser.get(userId) ?? [];
    list.push({ id: job.id, youtube_video_id: job.youtube_video_id });
    jobsByUser.set(userId, list);
  }

  for (const [userId, userJobs] of jobsByUser) {
    try {
      const { data: connection, error: connectionError } = await supabase
        .from("youtube_connections")
        .select("*")
        .eq("user_id", userId)
        .maybeSingle();
      if (connectionError || !connection) continue;

      const videoIdToJobIds = new Map<string, string[]>();
      for (const j of userJobs) {
        const list = videoIdToJobIds.get(j.youtube_video_id) ?? [];
        list.push(j.id);
        videoIdToJobIds.set(j.youtube_video_id, list);
      }

      const { stats, refreshedAccessToken, refreshedExpiresAt } = await fetchYoutubeVideoStats(
        {
          clientId: env.GOOGLE_CLIENT_ID,
          clientSecret: env.GOOGLE_CLIENT_SECRET,
          accessToken: connection.access_token,
          refreshToken: connection.refresh_token,
          expiryDate: new Date(connection.expires_at).getTime(),
        },
        [...videoIdToJobIds.keys()],
      );

      if (refreshedAccessToken) {
        await supabase
          .from("youtube_connections")
          .update({ access_token: refreshedAccessToken, expires_at: refreshedExpiresAt ?? connection.expires_at })
          .eq("id", connection.id);
      }

      const now = new Date().toISOString();
      for (const stat of stats) {
        const jobIds = videoIdToJobIds.get(stat.videoId) ?? [];
        if (jobIds.length === 0) continue;
        await supabase
          .from("youtube_publish_jobs")
          .update({
            view_count: stat.viewCount,
            like_count: stat.likeCount,
            comment_count: stat.commentCount,
            stats_updated_at: now,
          })
          .in("id", jobIds);
      }

      logger.info("Statistiche YouTube aggiornate", { userId, videos: stats.length });
    } catch (err) {
      logger.error("Refresh statistiche YouTube fallito per un utente", {
        userId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
}
