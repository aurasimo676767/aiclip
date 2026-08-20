import type { VideoRow, ProjectStatus } from "@clipforge/db";
import { supabase } from "../lib/supabase.js";
import { WORKER_ID } from "../lib/worker-id.js";
import { logger } from "../lib/logger.js";

/** Reclama il prossimo video pronto per la pipeline di analisi (o un job bloccato scaduto). */
export async function claimNextVideo(): Promise<VideoRow | null> {
  const { data, error } = await supabase.rpc("claim_next_video", { p_worker_id: WORKER_ID });
  if (error) {
    logger.error("claim_next_video fallita", { error: error.message });
    throw new Error(`claim_next_video fallita: ${error.message}`);
  }
  // Una funzione SQL "RETURNS public.videos" senza righe da restituire produce, via
  // PostgREST, una riga con tutti i campi null (non un vero JSON null) — va normalizzata qui.
  return data && data.id ? data : null;
}

export async function updateVideoStatus(
  videoId: string,
  status: ProjectStatus,
  fields: Partial<Pick<VideoRow, "error_message" | "duration_seconds" | "claimed_by" | "claimed_at">> = {},
): Promise<void> {
  const { error } = await supabase
    .from("videos")
    .update({ status, ...fields })
    .eq("id", videoId);
  if (error) {
    throw new Error(`Aggiornamento status video fallito: ${error.message}`);
  }

  // Il progetto rispecchia lo status del suo video (Fase 1: un video per progetto).
  const { data: video } = await supabase.from("videos").select("project_id").eq("id", videoId).single();
  if (video) {
    await supabase
      .from("projects")
      .update({ status, error_message: fields.error_message ?? null })
      .eq("id", video.project_id);
  }
}

export async function releaseVideoClaim(videoId: string): Promise<void> {
  const { error } = await supabase.from("videos").update({ claimed_by: null, claimed_at: null }).eq("id", videoId);
  if (error) {
    logger.warn("Impossibile rilasciare il claim del video", { videoId, error: error.message });
  }
}
