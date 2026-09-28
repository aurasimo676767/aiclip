import type { TiktokPublishJobRow } from "@clipforge/db";
import { supabase } from "../lib/supabase.js";
import { WORKER_ID } from "../lib/worker-id.js";
import { logger } from "../lib/logger.js";

/** Prossima pubblicazione TikTok in coda (claim_next_tiktok_publish_job, migrazione 0030). */
export async function claimNextTiktokPublishJob(): Promise<TiktokPublishJobRow | null> {
  const { data, error } = await supabase.rpc("claim_next_tiktok_publish_job", { p_worker_id: WORKER_ID });
  if (error) {
    // Prima della migrazione 0030 la funzione non esiste: niente coda TikTok, senza riempire il log.
    if (/claim_next_tiktok_publish_job|function .* does not exist|Could not find the function/i.test(error.message)) return null;
    logger.error("claim_next_tiktok_publish_job fallita", { error: error.message });
    throw new Error(`claim_next_tiktok_publish_job fallita: ${error.message}`);
  }
  return data && data.id ? data : null;
}
