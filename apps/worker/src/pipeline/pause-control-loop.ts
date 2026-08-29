import { setTimeout as sleep } from "node:timers/promises";
import { isWorkerPaused, suspendHeavyProcesses, resumeHeavyProcesses } from "../lib/pause-control.js";
import { logger } from "../lib/logger.js";

const CHECK_INTERVAL_MS = 3000;
// Mentre è in pausa, ri-sospende periodicamente: un processo pesante potrebbe essere partito
// nella breve finestra tra un controllo e l'altro (o subito prima della richiesta di pausa) e va
// preso comunque.
const RESWEEP_INTERVAL_MS = 5000;

/**
 * Sorveglia worker_control.paused e sospende/riprende DAVVERO i processi pesanti di conseguenza
 * (vedi lib/pause-control.ts). Le code (video/render/publish/voiceover/thumbnail) controllano
 * separatamente isWorkerPaused() prima di reclamare un nuovo job, così mentre è in pausa non ne
 * parte comunque uno nuovo che sfuggirebbe alla sospensione.
 */
export async function pauseControlLoop(): Promise<void> {
  let wasPaused = false;
  let lastSweep = 0;

  while (true) {
    try {
      const paused = await isWorkerPaused();

      if (paused && !wasPaused) {
        logger.info("Pausa richiesta dal sito: sospendo i processi pesanti in corso");
        await suspendHeavyProcesses();
        lastSweep = Date.now();
      } else if (!paused && wasPaused) {
        logger.info("Ripresa richiesta dal sito: riprendo i processi pesanti");
        await resumeHeavyProcesses();
      } else if (paused && Date.now() - lastSweep >= RESWEEP_INTERVAL_MS) {
        await suspendHeavyProcesses();
        lastSweep = Date.now();
      }

      wasPaused = paused;
    } catch (err) {
      logger.error("Errore nel loop di controllo pausa", { error: err instanceof Error ? err.message : String(err) });
    }
    await sleep(CHECK_INTERVAL_MS);
  }
}
