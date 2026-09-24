import type { ClipRow, ProjectRow, VideoRow } from "@clipforge/db";
import type { createSupabaseServerClient } from "@/lib/supabase/server";
import { getPresignedDownloadUrl } from "@/lib/storage/r2";

export interface ProjectSummary {
  project: ProjectRow;
  video: VideoRow | null;
  clipCount: number;
  completedClipCount: number;
  topScore: number | null;
  /** Immagine di copertina della card: miniatura YouTube della sorgente, o copertina della clip migliore. */
  coverUrl: string | null;
}

/** Miniatura pubblica di YouTube ricavata dall'URL (niente API, niente costi). */
export function youtubeThumbnail(url: string | null | undefined): string | null {
  if (!url) return null;
  const match = url.match(/(?:youtu\.be\/|[?&]v=|\/shorts\/|\/live\/)([\w-]{11})/);
  return match ? `https://i.ytimg.com/vi/${match[1]}/hqdefault.jpg` : null;
}

/** Media dei 6 punteggi (come overallScore), null se la clip non ne ha. */
function clipScore(raw: unknown): number | null {
  const s = raw as { hook?: number; retention?: number; emotion?: number; clarity?: number; payoff?: number; virality?: number } | null;
  if (!s) return null;
  const values = [s.hook, s.retention, s.emotion, s.clarity, s.payoff, s.virality].filter((v): v is number => typeof v === "number");
  return values.length > 0 ? values.reduce((sum, v) => sum + v, 0) / values.length : null;
}

type SupabaseServerClient = Awaited<ReturnType<typeof createSupabaseServerClient>>;

/**
 * Recupera i progetti dell'utente corrente (RLS-scoped) con un riassunto di video e clip.
 * Evita l'N+1 facendo 3 query batch (projects, videos, clips) invece di una per progetto.
 */
export async function fetchProjectSummaries(
  supabase: SupabaseServerClient,
  statusFilter?: ProjectRow["status"][],
  limit?: number,
): Promise<ProjectSummary[]> {
  let query = supabase.from("projects").select("*").order("created_at", { ascending: false });
  if (statusFilter && statusFilter.length > 0) {
    query = query.in("status", statusFilter);
  }
  if (limit) {
    query = query.limit(limit);
  }

  const { data: projects, error: projectsError } = await query;
  if (projectsError) {
    throw new Error(`Caricamento progetti fallito: ${projectsError.message}`);
  }
  if (!projects || projects.length === 0) {
    return [];
  }

  const projectIds = projects.map((p) => p.id);

  const [{ data: videos, error: videosError }, { data: clips, error: clipsError }] = await Promise.all([
    supabase.from("videos").select("*").in("project_id", projectIds),
    supabase.from("clips").select("id, project_id, status, scores, thumbnail_path").in("project_id", projectIds),
  ]);

  if (videosError) throw new Error(`Caricamento video fallito: ${videosError.message}`);
  if (clipsError) throw new Error(`Caricamento clip fallito: ${clipsError.message}`);

  const videosByProject = new Map<string, VideoRow>();
  for (const v of videos ?? []) {
    videosByProject.set(v.project_id, v);
  }

  const clipsByProject = new Map<string, Pick<ClipRow, "id" | "project_id" | "status" | "scores" | "thumbnail_path">[]>();
  for (const c of clips ?? []) {
    const list = clipsByProject.get(c.project_id) ?? [];
    list.push(c);
    clipsByProject.set(c.project_id, list);
  }

  return Promise.all(projects.map(async (project) => {
    const projectClips = clipsByProject.get(project.id) ?? [];
    const video = videosByProject.get(project.id) ?? null;
    const scores = projectClips.map((c) => clipScore(c.scores)).filter((v): v is number => v !== null);

    let coverUrl = youtubeThumbnail(video?.source_url);
    if (!coverUrl) {
      // La copertina della clip col punteggio più alto fra quelle già renderizzate. L'URL firmato
      // si calcola in locale (nessuna chiamata a R2), quindi non rallenta la pagina.
      const best = projectClips
        .filter((c) => c.thumbnail_path)
        .map((c) => ({ c, score: clipScore(c.scores) ?? 0 }))
        .sort((a, b) => b.score - a.score)[0];
      if (best?.c.thumbnail_path) {
        coverUrl = await getPresignedDownloadUrl(best.c.thumbnail_path, 6 * 3600).catch(() => null);
      }
    }

    return {
      project,
      video,
      clipCount: projectClips.length,
      completedClipCount: projectClips.filter((c) => c.status === "COMPLETED").length,
      topScore: scores.length > 0 ? Math.round(Math.max(...scores)) : null,
      coverUrl,
    };
  }));
}
