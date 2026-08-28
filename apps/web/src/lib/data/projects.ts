import type { ClipRow, ProjectRow, VideoRow } from "@clipforge/db";
import type { createSupabaseServerClient } from "@/lib/supabase/server";

export interface ProjectSummary {
  project: ProjectRow;
  video: VideoRow | null;
  clipCount: number;
  completedClipCount: number;
  topScore: number | null;
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
    supabase.from("clips").select("id, project_id, status, scores").in("project_id", projectIds),
  ]);

  if (videosError) throw new Error(`Caricamento video fallito: ${videosError.message}`);
  if (clipsError) throw new Error(`Caricamento clip fallito: ${clipsError.message}`);

  const videosByProject = new Map<string, VideoRow>();
  for (const v of videos ?? []) {
    videosByProject.set(v.project_id, v);
  }

  const clipsByProject = new Map<string, Pick<ClipRow, "id" | "project_id" | "status" | "scores">[]>();
  for (const c of clips ?? []) {
    const list = clipsByProject.get(c.project_id) ?? [];
    list.push(c);
    clipsByProject.set(c.project_id, list);
  }

  return projects.map((project) => {
    const projectClips = clipsByProject.get(project.id) ?? [];
    const scores = projectClips
      .map((c) => c.scores as { hook?: number; retention?: number; emotion?: number; clarity?: number; payoff?: number; virality?: number } | null)
      .filter((s): s is NonNullable<typeof s> => Boolean(s))
      .map((s) => {
        const values = [s.hook, s.retention, s.emotion, s.clarity, s.payoff, s.virality].filter(
          (v): v is number => typeof v === "number",
        );
        return values.length > 0 ? values.reduce((sum, v) => sum + v, 0) / values.length : 0;
      });

    return {
      project,
      video: videosByProject.get(project.id) ?? null,
      clipCount: projectClips.length,
      completedClipCount: projectClips.filter((c) => c.status === "COMPLETED").length,
      topScore: scores.length > 0 ? Math.round(Math.max(...scores)) : null,
    };
  });
}
