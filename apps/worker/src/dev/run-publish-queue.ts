import "dotenv/config";
import { claimNextPublishJob } from "../queue/publish-queue.js";
import { processPublishJob } from "../pipeline/process-publish-job.js";
import { logger } from "../lib/logger.js";

/**
 * Svuota la coda delle pubblicazioni YouTube in un processo a parte, con lo stesso codice del worker.
 * Serve quando il giro delle pubblicazioni del worker è bloccato e il worker non si può riavviare
 * (2026-10-25: un montaggio di Affari Tuoi in corso). Stesso claim del worker (SKIP LOCKED), quindi
 * niente doppioni se il worker si sblocca nel frattempo. Esce quando la coda è vuota.
 * Uso: tsx src/dev/run-publish-queue.ts
 */
for (;;) {
  const job = await claimNextPublishJob();
  if (!job) break;
  logger.info("Publish job claimato (processo a parte)", { jobId: job.id });
  await processPublishJob(job);
}
logger.info("Coda pubblicazioni YouTube vuota");
process.exit(0);
