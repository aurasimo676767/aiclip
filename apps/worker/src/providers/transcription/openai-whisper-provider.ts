import fs from "node:fs";
import path from "node:path";
import OpenAI from "openai";
import type { Transcript, TranscriptSegment, TranscriptWord } from "@clipforge/shared";
import { probeVideo } from "../../lib/ffmpeg.js";
import { logger } from "../../lib/logger.js";
import { splitAudioIntoChunks } from "./audio-chunker.js";
import type { TranscriptionProvider } from "./transcription-provider.js";

interface WhisperWord {
  word: string;
  start: number;
  end: number;
}

interface WhisperSegment {
  id: number;
  start: number;
  end: number;
  text: string;
}

interface WhisperVerboseResponse {
  text: string;
  language?: string;
  duration?: number;
  segments?: WhisperSegment[];
  words?: WhisperWord[];
}

export class OpenAIWhisperProvider implements TranscriptionProvider {
  private readonly client: OpenAI;

  constructor(apiKey: string, private readonly tmpDir: string) {
    this.client = new OpenAI({ apiKey });
  }

  async transcribe(audioFilePath: string): Promise<Transcript> {
    const fullDuration = (await probeVideo(audioFilePath)).durationSeconds;
    const chunks = await splitAudioIntoChunks(audioFilePath, this.tmpDir);

    logger.info("Trascrizione avviata", { chunks: chunks.length, audioFilePath });

    let segmentIdCounter = 0;
    const allSegments: TranscriptSegment[] = [];
    let language = "en";
    let fullTextParts: string[] = [];

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
      provider: "openai-whisper",
    };
  }

  private async transcribeChunk(filePath: string): Promise<WhisperVerboseResponse> {
    const stream = fs.createReadStream(filePath);
    try {
      const response = await this.client.audio.transcriptions.create({
        file: stream,
        model: "whisper-1",
        response_format: "verbose_json",
        timestamp_granularities: ["word", "segment"],
      });
      return response as unknown as WhisperVerboseResponse;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      throw new Error(`Trascrizione Whisper fallita per chunk "${path.basename(filePath)}": ${message}`);
    }
  }
}
