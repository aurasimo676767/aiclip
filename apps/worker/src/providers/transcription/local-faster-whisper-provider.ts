import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { request } from "undici";
import type { Transcript, TranscriptSegment } from "@clipforge/shared";
import { probeVideo } from "../../lib/ffmpeg.js";
import { logger } from "../../lib/logger.js";
import { splitAudioIntoChunks } from "./audio-chunker.js";
import type { TranscriptionProvider } from "./transcription-provider.js";
import { Mutex } from "../../lib/mutex.js";

// Se più video vengono processati in parallelo (VIDEO_CONCURRENCY > 1), NON deve arrivare più
// di una richiesta di trascrizione alla volta al server Whisper locale: gira su un'unica GPU
// con VRAM già limitata (verificato: una 3060 Ti 8GB è già al limite con un solo large-v3 in
// int8_float16) — due trascrizioni contemporanee rischiano OOM o un rallentamento severo
// invece di un vero guadagno di velocità. Le altre fasi della pipeline (download, ranking AI,
// scritture DB) restano comunque parallele tra i job: solo questa chiamata è serializzata.
const gpuMutex = new Mutex();

// Trascrivere un audio lungo su una GPU eventualmente condivisa con altri carichi (es. un
// gioco) può richiedere più dei ~5 minuti di timeout di default del fetch nativo di Node.
// Usiamo undici.request() direttamente (stesso pacchetto per client e dispatch) invece del
// fetch nativo di Node con un Agent esterno passato come `dispatcher`: quest'ultimo è
// incompatibile con l'undici INTERNO di Node (versione diversa da quella installata via npm)
// e fallisce subito con "invalid onRequestStart method", mascherato da un errore generico.
const LOCAL_WHISPER_TIMEOUT_MS = 30 * 60 * 1000; // 30 minuti

interface LocalWhisperWord {
  word: string;
  start: number;
  end: number;
}

interface LocalWhisperSegment {
  id: number;
  start: number;
  end: number;
  text: string;
}

interface LocalWhisperResponse {
  text: string;
  language?: string;
  duration?: number;
  segments?: LocalWhisperSegment[];
  words?: LocalWhisperWord[];
}

/**
 * TranscriptionProvider che usa faster-whisper self-hosted (vedi apps/worker/whisper-server/),
 * eseguito localmente sulla GPU invece dell'API a pagamento di OpenAI. Stesso formato di
 * output (segmenti + parole con timestamp) di OpenAIWhisperProvider, quindi il resto della
 * pipeline (captions, EDL) non nota differenza.
 */
export class LocalFasterWhisperProvider implements TranscriptionProvider {
  constructor(
    private readonly serverUrl: string,
    private readonly tmpDir: string,
  ) {}

  async transcribe(audioFilePath: string): Promise<Transcript> {
    return gpuMutex.run(() => this.transcribeLocked(audioFilePath));
  }

  /** GET /health: risponde in millisecondi, verifica che il server sia su prima di impegnarsi in un download lungo. */
  async checkReady(): Promise<void> {
    let response: Awaited<ReturnType<typeof request>>;
    try {
      response = await request(`${this.serverUrl}/health`, { method: "GET", headersTimeout: 5000, bodyTimeout: 5000 });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      throw new Error(
        `Server Whisper locale non raggiungibile su ${this.serverUrl} (avvialo da apps/worker/whisper-server/) — ${message}`,
      );
    }
    if (response.statusCode < 200 || response.statusCode >= 300) {
      throw new Error(`Server Whisper locale su ${this.serverUrl} non pronto: HTTP ${response.statusCode}`);
    }
  }

  private async transcribeLocked(audioFilePath: string): Promise<Transcript> {
    const fullDuration = (await probeVideo(audioFilePath)).durationSeconds;
    const chunks = await splitAudioIntoChunks(audioFilePath, this.tmpDir);

    logger.info("Trascrizione locale (faster-whisper) avviata", { chunks: chunks.length, audioFilePath, server: this.serverUrl });

    let segmentIdCounter = 0;
    const allSegments: TranscriptSegment[] = [];
    let language = "it";
    const fullTextParts: string[] = [];

    for (const chunk of chunks) {
      const response = await this.transcribeChunk(chunk.filePath);
      language = response.language ?? language;
      fullTextParts.push(response.text.trim());

      const words = (response.words ?? []).map((w) => ({
        word: w.word,
        start: w.start + chunk.offsetSeconds,
        end: w.end + chunk.offsetSeconds,
      }));

      const segments = response.segments ?? [];
      for (const seg of segments) {
        const start = seg.start + chunk.offsetSeconds;
        const end = seg.end + chunk.offsetSeconds;
        const segmentWords = words.filter((w) => w.start >= start - 0.05 && w.start < end + 0.05);

        allSegments.push({
          id: segmentIdCounter++,
          start,
          end,
          text: seg.text.trim(),
          words: segmentWords,
        });
      }
    }

    return {
      language,
      durationSeconds: fullDuration,
      fullText: fullTextParts.join(" ").trim(),
      segments: allSegments,
      provider: "local-faster-whisper",
    };
  }

  private async transcribeChunk(filePath: string): Promise<LocalWhisperResponse> {
    const fileBuffer = await fs.promises.readFile(filePath);
    const filename = path.basename(filePath);
    const boundary = `----clipforge${crypto.randomUUID()}`;
    const body = Buffer.concat([
      Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="audio"; filename="${filename}"\r\nContent-Type: application/octet-stream\r\n\r\n`,
      ),
      fileBuffer,
      Buffer.from(`\r\n--${boundary}--\r\n`),
    ]);

    let response: Awaited<ReturnType<typeof request>>;
    try {
      response = await request(`${this.serverUrl}/transcribe`, {
        method: "POST",
        headers: { "content-type": `multipart/form-data; boundary=${boundary}` },
        body,
        headersTimeout: LOCAL_WHISPER_TIMEOUT_MS,
        bodyTimeout: LOCAL_WHISPER_TIMEOUT_MS,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      throw new Error(
        `Impossibile raggiungere il server Whisper locale su ${this.serverUrl}. È avviato? (apps/worker/whisper-server/) — ${message}`,
      );
    }

    if (response.statusCode < 200 || response.statusCode >= 300) {
      const text = await response.body.text().catch(() => "");
      throw new Error(`Trascrizione locale fallita per chunk "${filename}": HTTP ${response.statusCode} ${text}`);
    }

    return (await response.body.json()) as LocalWhisperResponse;
  }
}
