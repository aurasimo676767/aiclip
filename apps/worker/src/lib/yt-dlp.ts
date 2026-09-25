import { spawn } from "node:child_process";
import { isWorkerPaused } from "./pause-control.js";

export class YtDlpError extends Error {
  constructor(
    message: string,
    public readonly stderr: string,
  ) {
    super(message);
    this.name = "YtDlpError";
  }
}

export interface YtDlpResult {
  stdout: string;
  stderr: string;
}

/**
 * Esegue yt-dlp e ne raccoglie stdout/stderr, con un timeout di INATTIVITÀ (non totale): il
 * cronometro si azzera a ogni output ricevuto. Prima era un timeout fisso di 20 minuti sull'intera
 * chiamata — bug reale osservato: un VOD Twitch di 5h13m (~23GB) veniva ucciso a metà ogni volta,
 * anche mentre stava scaricando normalmente, sprecando i tentativi disponibili. Con l'inattività,
 * un download lungo ma attivo non scade mai; solo un vero blocco (nessun output per tutta la
 * finestra) lo termina.
 */
export function runYtDlp(args: string[], options: { inactivityTimeoutMs?: number } = {}): Promise<YtDlpResult> {
  const inactivityTimeoutMs = options.inactivityTimeoutMs ?? 5 * 60 * 1000;

  return new Promise((resolve, reject) => {
    const child = spawn("yt-dlp", args, { windowsHide: true });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let timer: ReturnType<typeof setTimeout>;

    function resetTimer(): void {
      clearTimeout(timer);
      timer = setTimeout(() => {
        // In pausa dal sito yt-dlp è sospeso apposta e non scrive niente: non è un blocco. Prima
        // lo si uccideva lo stesso dopo 5 minuti di pausa (visto il 2026-09-25 su un VOD da 15GB).
        void isWorkerPaused()
          .catch(() => false)
          .then((paused) => {
            if (paused) {
              resetTimer();
              return;
            }
            timedOut = true;
            child.kill("SIGKILL");
          });
      }, inactivityTimeoutMs);
    }
    resetTimer();

    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString();
      resetTimer();
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
      resetTimer();
    });

    child.on("error", (err) => {
      clearTimeout(timer);
      reject(new YtDlpError(`Impossibile avviare yt-dlp: ${err.message}. È installato ed è nel PATH?`, stderr));
    });

    child.on("close", (code) => {
      clearTimeout(timer);
      if (timedOut) {
        reject(new YtDlpError(`yt-dlp fermo (nessun output) per più di ${inactivityTimeoutMs}ms, terminato`, stderr));
        return;
      }
      if (code !== 0) {
        reject(new YtDlpError(`yt-dlp terminato con codice ${code}: ${stderr.slice(-500)}`, stderr));
        return;
      }
      resolve({ stdout, stderr });
    });
  });
}
