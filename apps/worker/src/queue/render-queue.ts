import type { RenderJobRow, RenderJobStatus } from "@clipforge/db";
import { supabase } from "../lib/supabase.js";
import { WORKER_ID } from "../lib/worker-id.js";
import { logger } from "../lib/logger.js";

export async function claimNextRenderJob(): Promise<RenderJobRow | null> {
  const { data, error } = await supabase.rpc("claim_next_render_job", { p_worker_id: WORKER_ID });
  if (error) {
    logger.error("claim_next_render_job fallita", { error: error.message });
    throw new Error(`claim_next_render_job fallita: ${error.message}`);
  }
  // Vedi commento analogo in queue/video-queue.ts: nessuna riga -> tutti i campi null, non JSON null.
  return data && data.id ? data : null;
}

export async function updateRenderJobStatus(
  jobId: string,
  status: RenderJobStatus,
  fields: Partial<Pick<RenderJobRow, "stage" | "progress" | "error_message" | "completed_at">> = {},
): Promise<void> {
  const { error } = await supabase
    .from("render_jobs")
    .update({ status, ...fields })
    .eq("id", jobId);
  if (error) {
    throw new Error(`Aggiornamento status render_job fallito: ${error.message}`);
  }
}
