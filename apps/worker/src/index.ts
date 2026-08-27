import { env } from "./env.js";
import { logger } from "./lib/logger.js";
import { WORKER_ID } from "./lib/worker-id.js";
import { claimNextVideo } from "./queue/video-queue.js";
import { claimNextRenderJob } from "./queue/render-queue.js";
import { claimNextPublishJob } from "./queue/publish-queue.js";
import { claimNextVoiceoverJob } from "./queue/voiceover-queue.js";
import { processVideoJob } from "./pipeline/process-video-job.js";
import { processRenderJob } from "./pipeline/process-render-job.js";
import { processPublishJob } from "./pipeline/process-publish-job.js";
import { processVoiceoverJob } from "./pipeline/process-voiceover-job.js";
import { refreshYoutubeStats } from "./pipeline/refresh-youtube-stats.js";

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

/** Loop di polling per la coda di pubblicazione su YouTube. */
async function publishQueueLoop(): Promise<void> {
  while (!shuttingDown) {
    try {
      const job = await claimNextPublishJob();
      if (job) {
        logger.info("Publish job claimato", { jobId: job.id, workerId: WORKER_ID });
        await processPublishJob(job);
        continue;
      }
    } catch (err) {
      logger.error("Errore nel loop della coda publish", { error: err instanceof Error ? err.message : String(err) });
    }
    await sleep(env.QUEUE_POLL_INTERVAL_MS);
  }
}

/** Loop di polling per la coda "voice over" (clip + audio caricati manualmente, nessuna AI). */
async function voiceoverQueueLoop(): Promise<void> {
  while (!shuttingDown) {
    try {
      const job = await claimNextVoiceoverJob();
      if (job) {
        logger.info("Voiceover job claimato", { jobId: job.id, workerId: WORKER_ID });
        await processVoiceoverJob(job);
        continue;
      }
    } catch (err) {
      logger.error("Errore nel loop della coda voiceover", { error: err instanceof Error ? err.message : String(err) });
    }
    await sleep(env.QUEUE_POLL_INTERVAL_MS);
  }
}

const STATS_REFRESH_INTERVAL_MS = 20 * 60 * 1000; // ogni 20 minuti: sweep periodico, non una coda — non serve più frequente

/** Sweep periodico (non una coda): aggiorna views/like/commenti dei video già pubblicati. */
async function statsRefreshLoop(): Promise<void> {
  while (!shuttingDown) {
    try {
      await refreshYoutubeStats();
    } catch (err) {
      logger.error("Errore nel loop di refresh statistiche YouTube", { error: err instanceof Error ? err.message : String(err) });
    }
    await sleep(STATS_REFRESH_INTERVAL_MS);
  }
}

function handleShutdown(signal: string): void {
  logger.info(`Ricevuto ${signal}, arresto in corso dopo il job corrente...`);
  shuttingDown = true;
}

process.on("SIGINT", () => handleShutdown("SIGINT"));
process.on("SIGTERM", () => handleShutdown("SIGTERM"));

logger.info("ClipForge worker avviato", {
  workerId: WORKER_ID,
  pollIntervalMs: env.QUEUE_POLL_INTERVAL_MS,
  renderConcurrency: env.RENDER_CONCURRENCY,
  videoConcurrency: env.VIDEO_CONCURRENCY,
});

// Più copie degli stessi loop in parallelo: claim_next_video/claim_next_render_job usano già
// FOR UPDATE SKIP LOCKED, quindi più copie non si contendono mai lo stesso job.
const videoLoops = Array.from({ length: env.VIDEO_CONCURRENCY }, () => videoQueueLoop());
const renderLoops = Array.from({ length: env.RENDER_CONCURRENCY }, () => renderQueueLoop());

await Promise.all([...videoLoops, ...renderLoops, publishQueueLoop(), voiceoverQueueLoop(), statsRefreshLoop()]);
