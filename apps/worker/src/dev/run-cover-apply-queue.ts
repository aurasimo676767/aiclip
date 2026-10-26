import "dotenv/config";
import { claimNextThumbnailJob } from "../queue/thumbnail-queue.js";
import { processThumbnailJob } from "../pipeline/process-thumbnail-job.js";
import { logger } from "../lib/logger.js";

/**
 * Esegue in un processo a parte i "Carica copertina" rimasti in coda (gratis: la copertina c'è già,
 * si imposta solo su YouTube), quando il worker è spento o bloccato. Si ferma alla prima copertina
 * DA GENERARE, che costa: quella la fa il worker.
 * Uso: tsx src/dev/run-cover-apply-queue.ts
 */
for (;;) {
  const job = await claimNextThumbnailJob();
  if (!job) break;
  if (!job.apply_requested) {
    logger.warn("Copertina da generare in coda: mi fermo, la fa il worker", { jobId: job.id });
    break;
  }
  logger.info("Carica copertina (processo a parte)", { jobId: job.id, clipId: job.clip_id });
  await processThumbnailJob(job);
}
process.exit(0);
