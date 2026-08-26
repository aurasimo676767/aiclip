import type { ClipScores, ClipBadge } from "@clipforge/shared";
import type { createSupabaseServerClient } from "@/lib/supabase/server";
import type { ClipViewModel } from "@/components/clip-list";

type SupabaseServerClient = Awaited<ReturnType<typeof createSupabaseServerClient>>;

export interface ProjectDetail {
  project: { id: string; title: string; status: string; error_message: string | null };
  video: { original_filename: string; duration_seconds: number | null; error_message: string | null } | null;
  clips: ClipViewModel[];
}

/**
 * Carica progetto + video + clip (con view model completo, join sui job di pubblicazione
 * YouTube) per uno o più progetti in batch — usato sia dalla pagina di un singolo progetto
 * sia dalla vista "a colonne" di più progetti insieme (vedi dashboard/batch), evitando di
 * duplicare la logica di mapping/join in due posti.
 */
export async function fetchProjectDetails(supabase: SupabaseServerClient, projectIds: string[]): Promise<Map<string, ProjectDetail>> {
  const result = new Map<string, ProjectDetail>();
  if (projectIds.length === 0) return result;

  const [{ data: projects }, { data: videos }, { data: clipsRaw }] = await Promise.all([
    supabase.from("projects").select("id, title, status, error_message").in("id", projectIds),
    supabase.from("videos").select("project_id, original_filename, duration_seconds, error_message").in("project_id", projectIds),
    supabase
      .from("clips")
      .select("id, project_id, title, hook, reason, duration, scores, status, error_message, hashtags, caption, badges")
      .in("project_id", projectIds),
  ]);

  const clipIds = (clipsRaw ?? []).map((c) => c.id);
  const { data: publishJobsRaw } =
    clipIds.length > 0
      ? await supabase
          .from("youtube_publish_jobs")
          .select("clip_id, status, youtube_url, error_message, created_at, publish_at")
          .in("clip_id", clipIds)
          .order("created_at", { ascending: false })
      : { data: [] as never[] };

  // Solo il job di pubblicazione più recente per clip (l'array è già ordinato created_at desc).
  const latestPublishByClip = new Map<
    string,
    { status: string; youtubeUrl: string | null; errorMessage: string | null; publishAt: string | null }
  >();
  for (const job of publishJobsRaw ?? []) {
    if (!latestPublishByClip.has(job.clip_id)) {
      latestPublishByClip.set(job.clip_id, {
        status: job.status,
        youtubeUrl: job.youtube_url,
        errorMessage: job.error_message,
        publishAt: job.publish_at,
      });
    }
  }

  const videoByProject = new Map<string, ProjectDetail["video"]>();
  for (const v of videos ?? []) {
    videoByProject.set(v.project_id, {
      original_filename: v.original_filename,
      duration_seconds: v.duration_seconds,
      error_message: v.error_message,
    });
  }

  const clipsByProject = new Map<string, ClipViewModel[]>();
  for (const c of clipsRaw ?? []) {
    const publish = latestPublishByClip.get(c.id);
    const clip: ClipViewModel = {
      id: c.id,
      title: c.title,
      hook: c.hook,
      reason: c.reason,
      duration: c.duration,
      scores: c.scores as ClipScores,
      status: c.status,
      errorMessage: c.error_message,
      hashtags: (c.hashtags as string[] | null) ?? [],
      caption: c.caption ?? "",
      badges: (c.badges as ClipBadge[] | null) ?? [],
      youtubePublishStatus: publish?.status ?? null,
      youtubeUrl: publish?.youtubeUrl ?? null,
      youtubeError: publish?.errorMessage ?? null,
      youtubePublishAt: publish?.publishAt ?? null,
    };
    const list = clipsByProject.get(c.project_id) ?? [];
    list.push(clip);
    clipsByProject.set(c.project_id, list);
  }

  for (const project of projects ?? []) {
    result.set(project.id, {
      project,
      video: videoByProject.get(project.id) ?? null,
      clips: clipsByProject.get(project.id) ?? [],
    });
  }

  return result;
}

export async function fetchYoutubeConnected(supabase: SupabaseServerClient, userId: string): Promise<boolean> {
  const { data } = await supabase.from("youtube_connections").select("channel_title").eq("user_id", userId).maybeSingle();
  return Boolean(data);
}
