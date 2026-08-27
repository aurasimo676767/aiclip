import type { VoiceoverJobRow, VoiceoverJobStatus } from "@clipforge/db";
import { supabase } from "../lib/supabase.js";
import { WORKER_ID } from "../lib/worker-id.js";
import { logger } from "../lib/logger.js";
import { withNetworkRetry } from "../lib/retry.js";

export async function claimNextVoiceoverJob(): Promise<VoiceoverJobRow | null> {
  const { data, error } = await supabase.rpc("claim_next_voiceover_job", { p_worker_id: WORKER_ID });
  if (error) {
    logger.error("claim_next_voiceover_job fallita", { error: error.message });
    throw new Error(`claim_next_voiceover_job fallita: ${error.message}`);
  }
  // Nessuna riga -> tutti i campi null, non JSON null (vedi commento analogo in video-queue.ts).
  return data && data.id ? data : null;
}

export async function updateVoiceoverJobStatus(
  jobId: string,
  status: VoiceoverJobStatus,
  fields: Partial<Pick<VoiceoverJobRow, "error_message" | "output_video_path" | "claimed_by" | "claimed_at" | "attempts">> = {},
): Promise<void> {
  const { error } = await withNetworkRetry(
    () => supabase.from("voiceover_jobs").update({ status, ...fields }).eq("id", jobId),
    "Aggiornamento status voiceover_job",
  );
  if (error) {
    throw new Error(`Aggiornamento status voiceover_job fallito: ${error.message}`);
  }
}
