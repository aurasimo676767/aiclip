import type { YoutubePublishJobRow, YoutubePublishStatus } from "@clipforge/db";
import { supabase } from "../lib/supabase.js";
import { WORKER_ID } from "../lib/worker-id.js";
import { logger } from "../lib/logger.js";
import { withNetworkRetry } from "../lib/retry.js";

export async function claimNextPublishJob(): Promise<YoutubePublishJobRow | null> {
  const { data, error } = await supabase.rpc("claim_next_publish_job", { p_worker_id: WORKER_ID });
  if (error) {
    logger.error("claim_next_publish_job fallita", { error: error.message });
    throw new Error(`claim_next_publish_job fallita: ${error.message}`);
  }
  // Vedi commento analogo in queue/video-queue.ts: nessuna riga -> tutti i campi null, non JSON null.
  return data && data.id ? data : null;
}

export async function updatePublishJobStatus(
  jobId: string,
  status: YoutubePublishStatus,
  fields: Partial<Pick<YoutubePublishJobRow, "youtube_video_id" | "youtube_url" | "error_message" | "completed_at">> = {},
): Promise<void> {
  const { error } = await withNetworkRetry(
    () => supabase.from("youtube_publish_jobs").update({ status, ...fields }).eq("id", jobId),
    "Aggiornamento status publish_job",
  );
  if (error) {
    throw new Error(`Aggiornamento status publish_job fallito: ${error.message}`);
  }
}
