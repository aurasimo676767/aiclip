import { spawn, type ChildProcess } from "node:child_process";
import { AsyncLocalStorage } from "node:async_hooks";
import { logger } from "./logger.js";

export class FFmpegError extends Error {
  constructor(
    message: string,
    public readonly exitCode: number | null,
    public readonly stderr: string,
  ) {
    super(message);
    this.name = "FFmpegError";
  }
}

/** ffmpeg fermato perché l'utente ha annullato il lavoro (vedi withFfmpegCancel): non va ritentato. */
export class FFmpegCancelledError extends FFmpegError {
  constructor(stderr: string) {
    super("ffmpeg fermato: lavoro annullato dall'utente", null, stderr);
    this.name = "FFmpegCancelledError";
  }
}

/**
 * Ogni ffmpeg lanciato dentro fn si spegne appena signal scatta. Prima "Annulla" si vedeva solo fra
 * un passaggio e l'altro: la codifica finale di un montato da 4 ore andava avanti, e spenta a mano
 * ripartiva con la CPU (simo, 2026-10-28).
 */
const cancelScope = new AsyncLocalStorage<AbortSignal>();
export function withFfmpegCancel<T>(signal: AbortSignal, fn: () => Promise<T>): Promise<T> {
  return cancelScope.run(signal, fn);
}

/** Spegne child se il lavoro corrente viene annullato; restituisce chi lo controlla e chi stacca l'ascolto. */
function watchCancel(child: ChildProcess): { cancelled: () => boolean; stop: () => void } {
  const signal = cancelScope.getStore();
  let cancelled = false;
  const onAbort = () => {
    cancelled = true;
    child.kill("SIGKILL");
  };
  if (signal?.aborted) onAbort();
  else signal?.addEventListener("abort", onAbort, { once: true });
  return { cancelled: () => cancelled, stop: () => signal?.removeEventListener("abort", onAbort) };
}

interface RunOptions {
  timeoutMs?: number;
}

/** Esegue un binario (ffmpeg/ffprobe) e ne raccoglie stdout/stderr, con timeout opzionale. */
function run(bin: "ffmpeg" | "ffprobe", args: string[], options: RunOptions = {}): Promise<{ stdout: string; stderr: string }> {
  const timeoutMs = options.timeoutMs ?? 15 * 60 * 1000; // 15 minuti default, il render di una clip breve non dovrebbe mai avvicinarsi a questo limite

  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, { windowsHide: true });
    const cancel = watchCancel(child);
    let stdout = "";
    let stderr = "";
    let timedOut = false;

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, timeoutMs);

    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });

    child.on("error", (err) => {
      clearTimeout(timer);
      reject(new FFmpegError(`Impossibile avviare ${bin}: ${err.message}. È installato ed è nel PATH?`, null, stderr));
    });

    child.on("close", (code) => {
      clearTimeout(timer);
      cancel.stop();
      if (cancel.cancelled()) {
        reject(new FFmpegCancelledError(stderr));
        return;
      }
      if (timedOut) {
        reject(new FFmpegError(`${bin} ha superato il timeout di ${timeoutMs}ms ed è stato terminato`, code, stderr));
        return;
      }
      if (code !== 0) {
        // Prima mancava la coda di stderr nel messaggio (a differenza di runFfmpegBinary, che
        // ce l'aveva già) — un errore "terminato con codice N" senza altro contesto è quasi
        // inutile per capire COSA è andato storto davvero (osservato in pratica: un crash con
        // codice 4294967294 senza nessun dettaglio su cosa l'avesse causato).
        reject(new FFmpegError(`${bin} terminato con codice ${code}: ${stderr.slice(-800)}`, code, stderr));
        return;
      }
      resolve({ stdout, stderr });
    });
  });
}

/**
 * Salto PRECISO in un sorgente (2026-11-06, simo: zoom "completamente desyncati"). Nei .ts dei VOD
 * Twitch, `-ss X -i file` fa ripartire il video solo dal fotogramma chiave dopo X: misurato sul VOD
 * Manchester-Roma, il primo fotogramma era il contenuto di X+1,13 s (con il tempo giusto, 1,13), mentre
 * l'audio partiva da X. Chi rimetteva i tempi a zero (setpts=PTS-STARTPTS) o contava i fotogrammi dal
 * primo spostava il video di 1,1 s: zoom fuori sincrono e il modello chi-parla che confrontava labbra
 * e voce di momenti diversi. Qui si salta SEEK_PREROLL_SECONDS prima e si taglia sui tempi veri.
 */
export const SEEK_PREROLL_SECONDS = 3;

/** Ingresso da `at` (per `duration` secondi, se data) con il margine prima: da usare con exactSeekTrim. */
export function exactSeekInput(file: string, at: number, duration?: number): string[] {
  const from = Math.max(0, at - SEEK_PREROLL_SECONDS);
  return ["-ss", from.toFixed(3), ...(duration !== undefined ? ["-t", (duration + (at - from)).toFixed(3)] : []), "-i", file];
}

/** Il margine effettivo prima di `at` (minore vicino all'inizio del file). */
export function seekPreroll(at: number): number {
  return at - Math.max(0, at - SEEK_PREROLL_SECONDS);
}

/** Filtri che tolgono il margine: il video (o l'audio) comincia esattamente da `at`, coi tempi da zero. */
export function exactSeekTrim(at: number, duration: number | undefined, kind: "v" | "a"): string {
  const pre = seekPreroll(at).toFixed(3);
  const len = duration !== undefined ? `:duration=${duration.toFixed(3)}` : "";
  return kind === "v" ? `trim=start=${pre}${len},setpts=PTS-STARTPTS` : `atrim=start=${pre}${len},asetpts=PTS-STARTPTS`;
}

/** Un solo fotogramma esattamente a `at`: il salto in uscita (dopo -i) usa i tempi veri dei fotogrammi. */
export function exactFrameArgs(file: string, at: number): string[] {
  return [...exactSeekInput(file, at), "-ss", seekPreroll(at).toFixed(3)];
}

export function runFfmpeg(args: string[], options?: RunOptions): Promise<{ stdout: string; stderr: string }> {
  logger.info("ffmpeg", { args: args.join(" ") });
  return run("ffmpeg", args, options);
}

export function runFfprobe(args: string[], options?: RunOptions): Promise<{ stdout: string; stderr: string }> {
  return run("ffprobe", args, options);
}

/**
 * Come `runFfmpeg`, ma raccoglie stdout come Buffer binario invece che stringa — necessario
 * quando l'output è un frame raw (`-f rawvideo`), non testo, altrimenti i byte vengono
 * corrotti dalla conversione a stringa.
 */
export function runFfmpegBinary(args: string[], options: RunOptions = {}): Promise<Buffer> {
  const timeoutMs = options.timeoutMs ?? 60 * 1000;

  return new Promise((resolve, reject) => {
    const child = spawn("ffmpeg", args, { windowsHide: true });
    const cancel = watchCancel(child);
    const stdoutChunks: Buffer[] = [];
    let stderr = "";
    let timedOut = false;

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, timeoutMs);

    child.stdout.on("data", (chunk: Buffer) => {
      stdoutChunks.push(chunk);
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });

    child.on("error", (err) => {
      clearTimeout(timer);
      reject(new FFmpegError(`Impossibile avviare ffmpeg: ${err.message}`, null, stderr));
    });

    child.on("close", (code) => {
      clearTimeout(timer);
      cancel.stop();
      if (cancel.cancelled()) {
        reject(new FFmpegCancelledError(stderr));
        return;
      }
      if (timedOut) {
        reject(new FFmpegError(`ffmpeg ha superato il timeout di ${timeoutMs}ms ed è stato terminato`, code, stderr));
        return;
      }
      if (code !== 0) {
        reject(new FFmpegError(`ffmpeg terminato con codice ${code}: ${stderr.slice(-500)}`, code, stderr));
        return;
      }
      resolve(Buffer.concat(stdoutChunks));
    });
  });
}

export interface ProbeResult {
  durationSeconds: number;
  width: number | null;
  height: number | null;
  hasVideo: boolean;
  hasAudio: boolean;
}

export async function probeVideo(filePath: string): Promise<ProbeResult> {
  const { stdout } = await runFfprobe([
    "-v",
    "error",
    "-print_format",
    "json",
    "-show_format",
    "-show_streams",
    filePath,
  ]);

  const data = JSON.parse(stdout) as {
    format?: { duration?: string };
    streams?: Array<{ codec_type?: string; width?: number; height?: number; duration?: string }>;
  };

  const videoStream = data.streams?.find((s) => s.codec_type === "video");
  const audioStream = data.streams?.find((s) => s.codec_type === "audio");
  const durationStr = data.format?.duration ?? videoStream?.duration ?? "0";

  return {
    durationSeconds: Number.parseFloat(durationStr) || 0,
    width: videoStream?.width ?? null,
    height: videoStream?.height ?? null,
    hasVideo: Boolean(videoStream),
    hasAudio: Boolean(audioStream),
  };
}
