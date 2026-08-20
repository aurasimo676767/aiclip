import { env } from "./env.js";
import { logger } from "./lib/logger.js";
import { WORKER_ID } from "./lib/worker-id.js";
import { claimNextVideo } from "./queue/video-queue.js";
import { claimNextRenderJob } from "./queue/render-queue.js";
import { processVideoJob } from "./pipeline/process-video-job.js";
import { processRenderJob } from "./pipeline/process-render-job.js";

let shuttingDown = false;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Loop di polling per la coda di analisi video (upload -> transcript -> AI -> clip suggerite). */
async function videoQueueLoop(): Promise<void> {
  while (!shuttingDown) {
    try {
      const video = await claimNextVideo();
      if (video) {
        logger.info("Video claimato", { videoId: video.id, workerId: WORKER_ID });
        await processVideoJob(video);
        continue; // riprova subito, potrebbero esserci altri job in coda
      }
    } catch (err) {
      logger.error("Errore nel loop della coda video", { error: err instanceof Error ? err.message : String(err) });
    }
    await sleep(env.QUEUE_POLL_INTERVAL_MS);
  }
}

/** Loop di polling per la coda di render delle singole clip. */
async function renderQueueLoop(): Promise<void> {
  while (!shuttingDown) {
    try {
      const job = await claimNextRenderJob();
      if (job) {
        logger.info("Render job claimato", { jobId: job.id, workerId: WORKER_ID });
        await processRenderJob(job);
        continue;
      }
    } catch (err) {
      logger.error("Errore nel loop della coda render", { error: err instanceof Error ? err.message : String(err) });
    }
    await sleep(env.QUEUE_POLL_INTERVAL_MS);
  }
}

function handleShutdown(signal: string): void {
  logger.info(`Ricevuto ${signal}, arresto in corso dopo il job corrente...`);
  shuttingDown = true;
}

process.on("SIGINT", () => handleShutdown("SIGINT"));
process.on("SIGTERM", () => handleShutdown("SIGTERM"));

logger.info("ClipForge worker avviato", { workerId: WORKER_ID, pollIntervalMs: env.QUEUE_POLL_INTERVAL_MS });

await Promise.all([videoQueueLoop(), renderQueueLoop()]);
