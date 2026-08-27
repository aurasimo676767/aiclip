import { overallScore, EDITING_STYLES, CLIP_BADGES, type ClipBadge, type ClipScores } from "@clipforge/shared";
import { supabase } from "../../lib/supabase.js";
import { logger } from "../../lib/logger.js";

// Sotto questa soglia il segnale è troppo rumoroso (poche clip pubblicate = differenze di
// views dovute al caso, non al contenuto) — meglio non dare all'AI dati fuorvianti che
// inventarsi un pattern da 3 clip.
const MIN_CLIPS_FOR_FEEDBACK = 12;
const MIN_SAMPLES_PER_GROUP = 3;
const TOP_BOTTOM_COUNT = 3;

interface PerformanceEntry {
  title: string;
  editingStyle: string | null;
  badges: ClipBadge[];
  aiScore: number | null;
  views: number;
  engagementRate: number; // (like+commenti) / views
}

/**
 * Costruisce un riassunto testuale delle performance REALI (views/engagement) delle clip già
 * pubblicate dall'utente su YouTube, da iniettare nel prompt di ranking — così l'AI calibra le
 * scelte su cosa funziona DAVVERO con questo pubblico specifico, invece di giudicare solo sulla
 * base del proprio istinto stimato. Ritorna null se non c'è ancora abbastanza storico
 * (MIN_CLIPS_FOR_FEEDBACK) per essere un segnale affidabile invece che rumore.
 */
export async function buildPerformanceFeedback(userId: string): Promise<string | null> {
  try {
    const { data: projects, error: projectsError } = await supabase.from("projects").select("id").eq("user_id", userId);
    if (projectsError || !projects || projects.length === 0) return null;
    const projectIds = projects.map((p) => p.id);

    const { data: clips, error: clipsError } = await supabase
      .from("clips")
      .select("id, title, editing_style, badges, scores")
      .in("project_id", projectIds);
    if (clipsError || !clips || clips.length === 0) return null;
    const clipById = new Map(clips.map((c) => [c.id, c]));

    const { data: jobs, error: jobsError } = await supabase
      .from("youtube_publish_jobs")
      .select("clip_id, view_count, like_count, comment_count")
      .in(
        "clip_id",
        clips.map((c) => c.id),
      )
      .eq("status", "COMPLETED")
      .is("cancelled_at", null)
      .not("view_count", "is", null);
    if (jobsError || !jobs) return null;

    const entries: PerformanceEntry[] = [];
    for (const job of jobs) {
      const clip = clipById.get(job.clip_id);
      const views = job.view_count;
      if (!clip || views === null || views < 1) continue;
      const likes = job.like_count ?? 0;
      const comments = job.comment_count ?? 0;
      entries.push({
        title: clip.title,
        editingStyle: clip.editing_style,
        badges: (clip.badges as ClipBadge[] | null) ?? [],
        aiScore: clip.scores ? overallScore(clip.scores as ClipScores) : null,
        views,
        engagementRate: (likes + comments) / views,
      });
    }

    if (entries.length < MIN_CLIPS_FOR_FEEDBACK) return null;

    const avgViews = entries.reduce((sum, e) => sum + e.views, 0) / entries.length;

    const badgeLines: string[] = [];
    for (const badge of CLIP_BADGES) {
      const withBadge = entries.filter((e) => e.badges.includes(badge));
      if (withBadge.length < MIN_SAMPLES_PER_GROUP) continue;
      const avg = withBadge.reduce((sum, e) => sum + e.views, 0) / withBadge.length;
      const deltaPct = Math.round(((avg - avgViews) / avgViews) * 100);
      badgeLines.push(`"${badge}": ${deltaPct >= 0 ? "+" : ""}${deltaPct}% views vs media (${withBadge.length} clip)`);
    }

    const styleLines: string[] = [];
    for (const style of EDITING_STYLES) {
      const withStyle = entries.filter((e) => e.editingStyle === style);
      if (withStyle.length < MIN_SAMPLES_PER_GROUP) continue;
      const avg = withStyle.reduce((sum, e) => sum + e.views, 0) / withStyle.length;
      const deltaPct = Math.round(((avg - avgViews) / avgViews) * 100);
      styleLines.push(`"${style}": ${deltaPct >= 0 ? "+" : ""}${deltaPct}% views vs media (${withStyle.length} clip)`);
    }

    const byViewsDesc = [...entries].sort((a, b) => b.views - a.views);
    const top = byViewsDesc.slice(0, TOP_BOTTOM_COUNT);
    const bottom = byViewsDesc.slice(-TOP_BOTTOM_COUNT).reverse();

    const formatEntry = (e: PerformanceEntry) =>
      `"${e.title}" — ${Math.round(e.views).toLocaleString("it-IT")} views, engagement ${(e.engagementRate * 100).toFixed(1)}%${
        e.aiScore !== null ? `, punteggio AI dato all'epoca: ${e.aiScore}` : ""
      }${e.badges.length > 0 ? `, badge: ${e.badges.join(", ")}` : ""}${e.editingStyle ? `, stile: ${e.editingStyle}` : ""}`;

    const sections = [
      `Basato su ${entries.length} clip già pubblicate con statistiche reali (views medie: ${Math.round(avgViews).toLocaleString("it-IT")}).`,
    ];
    if (badgeLines.length > 0) sections.push(`Badge vs performance reale:\n${badgeLines.map((l) => `- ${l}`).join("\n")}`);
    if (styleLines.length > 0) sections.push(`Editing style vs performance reale:\n${styleLines.map((l) => `- ${l}`).join("\n")}`);
    sections.push(`Le ${top.length} clip andate MEGLIO:\n${top.map((e) => `- ${formatEntry(e)}`).join("\n")}`);
    sections.push(
      `Le ${bottom.length} clip andate PEGGIO (confronta col punteggio AI dato all'epoca — se era alto, capisci cosa NON funziona davvero con questo pubblico nonostante sembrasse una buona clip):\n${bottom.map((e) => `- ${formatEntry(e)}`).join("\n")}`,
    );

    return sections.join("\n\n");
  } catch (err) {
    // Il feedback storico è un bonus, non deve mai far fallire l'intera pipeline di ranking.
    logger.warn("Costruzione feedback performance fallita, procedo senza", {
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}
