import type { createSupabaseServerClient } from "@/lib/supabase/server";
import { getPresignedDownloadUrl } from "@/lib/storage/r2";
import { youtubeThumbnail } from "./projects";

type SupabaseServerClient = Awaited<ReturnType<typeof createSupabaseServerClient>>;

const PROCESSING_STATUSES = ["UPLOADED", "DOWNLOADING", "EXTRACTING_AUDIO", "TRANSCRIBING", "ANALYZING", "CLIP_SELECTION"] as const;
/** Oltre questo silenzio il worker è considerato spento (batte ogni 15 secondi). */
const OFFLINE_AFTER_MS = 60_000;

export interface PcTask {
  kind: "video" | "render";
  id: string;
  title: string;
  /** Fase leggibile ("Trascrizione", "Render dello Short"…). */
  stage: string;
  /** 0-100 se noto. */
  progress: number | null;
  imageUrl: string | null;
  /** Dove si apre toccandolo. */
  href: string;
  /** Formato dell'immagine: i render sono Shorts verticali. */
  portrait: boolean;
}

export interface PcStatus {
  state: "working" | "idle" | "paused" | "offline";
  lastSeenAt: string | null;
  current: PcTask[];
  queuedRenders: number;
  queuedVideos: number;
}

export interface ReadyShort {
  id: string;
  projectId: string;
  title: string;
  duration: number;
  thumbnailUrl: string | null;
  publishedOnYoutube: boolean;
}

const VIDEO_STAGE: Record<string, string> = {
  UPLOADED: "In attesa",
  DOWNLOADING: "Download",
  EXTRACTING_AUDIO: "Estrazione audio",
  TRANSCRIBING: "Trascrizione",
  ANALYZING: "L'AI cerca i momenti migliori",
  CLIP_SELECTION: "Scelta delle clip",
};
const VIDEO_PROGRESS: Record<string, number> = { UPLOADED: 5, DOWNLOADING: 18, EXTRACTING_AUDIO: 28, TRANSCRIBING: 55, ANALYZING: 85, CLIP_SELECTION: 95 };

/**
 * Cosa sta facendo il PC di simo adesso, per la Home: acceso o spento (battito del worker), in pausa,
 * il video che sta elaborando, lo Short che sta renderizzando e quanti ne aspettano.
 */
export async function fetchPcStatus(supabase: SupabaseServerClient): Promise<PcStatus> {
  const [{ data: control }, { data: videos }, { data: renders }, { count: queuedRenders }] = await Promise.all([
    supabase.from("worker_control").select("paused, last_seen_at").eq("id", true).maybeSingle(),
    supabase
      .from("videos")
      .select("id, project_id, status, original_filename, source_url, projects(title)")
      .in("status", [...PROCESSING_STATUSES])
      .order("created_at", { ascending: true })
      .limit(6),
    supabase
      .from("render_jobs")
      .select("id, stage, progress, mode, clip_id, clips(title, project_id, thumbnail_path)")
      .eq("status", "RENDERING")
      .order("created_at", { ascending: true })
      .limit(3),
    supabase.from("render_jobs").select("id", { count: "exact", head: true }).eq("status", "PENDING"),
  ]);

  const lastSeenAt = control?.last_seen_at ?? null;
  const online = lastSeenAt !== null && Date.now() - new Date(lastSeenAt).getTime() < OFFLINE_AFTER_MS;

  const current: PcTask[] = [];
  for (const r of renders ?? []) {
    const clip = r.clips as unknown as { title: string; project_id: string; thumbnail_path: string | null } | null;
    current.push({
      kind: "render",
      id: r.id,
      title: clip?.title ?? "Short",
      stage: r.mode === "captions" ? "Applica lo stile dei sottotitoli" : r.stage === "uploading" ? "Caricamento" : "Render dello Short",
      progress: typeof r.progress === "number" ? r.progress : null,
      imageUrl: clip?.thumbnail_path ? await getPresignedDownloadUrl(clip.thumbnail_path, 6 * 3600).catch(() => null) : null,
      href: clip ? `/dashboard/projects/${clip.project_id}?clip=${r.clip_id}` : "/dashboard",
      portrait: true,
    });
  }
  const working = (videos ?? []).filter((v) => v.status !== "UPLOADED");
  for (const v of working) {
    const project = v.projects as unknown as { title: string } | null;
    current.push({
      kind: "video",
      id: v.id,
      title: project?.title ?? v.original_filename,
      stage: VIDEO_STAGE[v.status] ?? "Elaborazione",
      progress: VIDEO_PROGRESS[v.status] ?? null,
      imageUrl: youtubeThumbnail(v.source_url),
      href: `/dashboard/projects/${v.project_id}`,
      portrait: false,
    });
  }

  const busy = current.length > 0 || (queuedRenders ?? 0) > 0;
  return {
    state: !online ? "offline" : control?.paused ? "paused" : busy ? "working" : "idle",
    lastSeenAt,
    current,
    queuedRenders: queuedRenders ?? 0,
    queuedVideos: (videos ?? []).filter((v) => v.status === "UPLOADED").length,
  };
}

/** Gli ultimi Shorts pronti (renderizzati), per la striscia in Home. */
export async function fetchReadyShorts(supabase: SupabaseServerClient, limit = 12): Promise<ReadyShort[]> {
  const { data: clips } = await supabase
    .from("clips")
    .select("id, project_id, title, duration, thumbnail_path, cover_path, format, updated_at")
    .eq("status", "COMPLETED")
    .neq("format", "longform")
    .order("updated_at", { ascending: false })
    .limit(limit);
  const ids = (clips ?? []).map((c) => c.id);
  const { data: published } =
    ids.length > 0 ? await supabase.from("youtube_publish_jobs").select("clip_id, status").in("clip_id", ids) : { data: [] as Array<{ clip_id: string; status: string }> };
  const publishedIds = new Set((published ?? []).filter((p) => p.status === "COMPLETED").map((p) => p.clip_id));
  return Promise.all(
    (clips ?? []).map(async (c) => ({
      id: c.id,
      projectId: c.project_id,
      title: c.title,
      duration: c.duration,
      thumbnailUrl: c.cover_path ?? c.thumbnail_path ? await getPresignedDownloadUrl((c.cover_path ?? c.thumbnail_path)!, 6 * 3600).catch(() => null) : null,
      publishedOnYoutube: publishedIds.has(c.id),
    })),
  );
}
