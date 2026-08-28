import type { ThumbnailJobRow, ThumbnailJobStatus } from "@clipforge/db";
import { supabase } from "../lib/supabase.js";
import { WORKER_ID } from "../lib/worker-id.js";
import { logger } from "../lib/logger.js";
import { withNetworkRetry } from "../lib/retry.js";

export async function claimNextThumbnailJob(): Promise<ThumbnailJobRow | null> {
  const { data, error } = await supabase.rpc("claim_next_thumbnail_job", { p_worker_id: WORKER_ID });
  if (error) {
    logger.error("claim_next_thumbnail_job fallita", { error: error.message });
    throw new Error(`claim_next_thumbnail_job fallita: ${error.message}`);
  }
  return data && data.id ? data : null;
}

export async function updateThumbnailJobStatus(
  jobId: string,
  status: ThumbnailJobStatus,
  fields: Partial<Pick<ThumbnailJobRow, "result_storage_path" | "youtube_thumbnail_set" | "error_message" | "completed_at">> = {},
): Promise<void> {
  const { error } = await withNetworkRetry(
    () => supabase.from("thumbnail_jobs").update({ status, ...fields }).eq("id", jobId),
    "Aggiornamento status thumbnail_job",
  );
  if (error) {
    throw new Error(`Aggiornamento status thumbnail_job fallito: ${error.message}`);
  }
}
