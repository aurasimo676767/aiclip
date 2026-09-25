import type { ClipScores, ClipBadge, VideoUsageStats } from "@clipforge/shared";
import type { createSupabaseServerClient } from "@/lib/supabase/server";
import type { ClipViewModel } from "@/components/clip-list";
import { getPresignedDownloadUrl } from "@/lib/storage/r2";

type SupabaseServerClient = Awaited<ReturnType<typeof createSupabaseServerClient>>;

export interface ProjectDetail {
  project: { id: string; title: string; status: string; error_message: string | null; source_type: string };
  video: {
    original_filename: string;
    duration_seconds: number | null;
    error_message: string | null;
    usageStats: VideoUsageStats | null;
  } | null;
  clips: ClipViewModel[];
}

/**
 * Preset di descrizione per la pubblicazione dei video long-form: solo crediti allo streamer
 * originale, niente riassunto "rappresentativo" del contenuto (quello lo scriveva l'IA in
 * clip.caption, ma su richiesta non è più il default del form di pubblicazione).
 */
function buildLongformDescriptionPreset(streamerName: string | null, streamerLogin: string | null): string {
  if (!streamerName) return "";
  const twitchLine = streamerLogin
    ? `Guarda le live intere su Twitch: https://www.twitch.tv/${streamerLogin}`
    : `Guarda le live intere sul canale Twitch di ${streamerName}`;
  return `Live originale di ${streamerName}.\n${twitchLine}`;
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
    supabase.from("projects").select("id, title, status, error_message, source_type").in("id", projectIds),
    supabase
      .from("videos")
      .select("project_id, original_filename, duration_seconds, error_message, streamer_name, streamer_login, usage_stats")
      .in("project_id", projectIds),
    supabase
      .from("clips")
      // "*" e non l'elenco delle colonne: così la pagina regge anche prima della migrazione 0024
      // (longform_edit), che va lanciata a mano su Supabase — senza colonna vale semplicemente false.
      .select("*")
      .in("project_id", projectIds),
  ]);

  const clipIds = (clipsRaw ?? []).map((c) => c.id);
  const { data: publishJobsRaw } =
    clipIds.length > 0
      ? await supabase
          .from("youtube_publish_jobs")
          .select("clip_id, status, youtube_url, error_message, created_at, publish_at, cancelled_at")
          .in("clip_id", clipIds)
          .order("created_at", { ascending: false })
      : { data: [] as never[] };

  // Solo il job di pubblicazione più recente per clip (l'array è già ordinato created_at desc).
  const latestPublishByClip = new Map<
    string,
    { status: string; youtubeUrl: string | null; errorMessage: string | null; publishAt: string | null; cancelledAt: string | null }
  >();
  for (const job of publishJobsRaw ?? []) {
    if (!latestPublishByClip.has(job.clip_id)) {
      latestPublishByClip.set(job.clip_id, {
        status: job.status,
        youtubeUrl: job.youtube_url,
        errorMessage: job.error_message,
        publishAt: job.publish_at,
        cancelledAt: job.cancelled_at,
      });
    }
  }

  const videoByProject = new Map<string, ProjectDetail["video"]>();
  const streamerByProject = new Map<string, { name: string | null; login: string | null }>();
  for (const v of videos ?? []) {
    videoByProject.set(v.project_id, {
      original_filename: v.original_filename,
      duration_seconds: v.duration_seconds,
      error_message: v.error_message,
      usageStats: (v.usage_stats as VideoUsageStats | null) ?? null,
    });
    streamerByProject.set(v.project_id, { name: v.streamer_name, login: v.streamer_login });
  }

  // URL firmati di copertina e video, per la griglia (anteprima al passaggio del mouse) e il
  // player: si calcolano in locale (nessuna chiamata a R2), quindi costano solo qualche ms.
  const mediaUrls = new Map<string, { thumbnailUrl: string | null; videoUrl: string | null }>();
  await Promise.all(
    (clipsRaw ?? []).map(async (c) => {
      const sign = (path: string | null) => (path ? getPresignedDownloadUrl(path, 6 * 3600).catch(() => null) : Promise.resolve(null));
      const [thumbnailUrl, videoUrl] = await Promise.all([
        sign(c.thumbnail_path),
        c.status === "COMPLETED" ? sign(c.output_video_path) : Promise.resolve(null),
      ]);
      mediaUrls.set(c.id, { thumbnailUrl, videoUrl });
    }),
  );

  const clipsByProject = new Map<string, ClipViewModel[]>();
  for (const c of clipsRaw ?? []) {
    const publish = latestPublishByClip.get(c.id);
    const streamer = streamerByProject.get(c.project_id);
    // Una descrizione scritta a mano vince sul testo generato (vedi clips.publish_description).
    const publishDescription =
      c.publish_description ??
      (c.format === "longform" ? buildLongformDescriptionPreset(streamer?.name ?? null, streamer?.login ?? null) : (c.caption ?? ""));
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
      publishDescription,
      badges: (c.badges as ClipBadge[] | null) ?? [],
      format: c.format,
      longformEdit: (c as { longform_edit?: boolean }).longform_edit === true,
      youtubePublishStatus: publish?.status ?? null,
      youtubeUrl: publish?.youtubeUrl ?? null,
      youtubeError: publish?.errorMessage ?? null,
      youtubePublishAt: publish?.publishAt ?? null,
      youtubeCancelledAt: publish?.cancelledAt ?? null,
      thumbnailUrl: mediaUrls.get(c.id)?.thumbnailUrl ?? null,
      videoUrl: mediaUrls.get(c.id)?.videoUrl ?? null,
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
