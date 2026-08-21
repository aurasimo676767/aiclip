import fs from "node:fs";
import path from "node:path";
import type { Transcript, TranscriptSegment } from "@clipforge/shared";
import { probeVideo } from "../../lib/ffmpeg.js";
import { logger } from "../../lib/logger.js";
import { splitAudioIntoChunks } from "./audio-chunker.js";
import type { TranscriptionProvider } from "./transcription-provider.js";

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
    const buffer = await fs.promises.readFile(filePath);
    const form = new FormData();
    form.append("audio", new Blob([buffer]), path.basename(filePath));

    let response: Response;
    try {
      response = await fetch(`${this.serverUrl}/transcribe`, { method: "POST", body: form });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      throw new Error(
        `Impossibile raggiungere il server Whisper locale su ${this.serverUrl}. È avviato? (apps/worker/whisper-server/) — ${message}`,
      );
    }

    if (!response.ok) {
      const body = await response.text().catch(() => "");
      throw new Error(`Trascrizione locale fallita per chunk "${path.basename(filePath)}": HTTP ${response.status} ${body}`);
    }

    return (await response.json()) as LocalWhisperResponse;
  }
}
