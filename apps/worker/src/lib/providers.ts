import { R2StorageProvider } from "../storage/r2-storage-provider.js";
import { OpenAIWhisperProvider } from "../providers/transcription/openai-whisper-provider.js";
import { LocalFasterWhisperProvider } from "../providers/transcription/local-faster-whisper-provider.js";
import type { TranscriptionProvider } from "../providers/transcription/transcription-provider.js";
import { ReactionCamFaceTracker } from "../face-tracking/reaction-cam-face-tracker.js";
import { env } from "../env.js";

export const storageProvider = new R2StorageProvider({
  accountId: env.R2_ACCOUNT_ID,
  accessKeyId: env.R2_ACCESS_KEY_ID,
  secretAccessKey: env.R2_SECRET_ACCESS_KEY,
  bucket: env.R2_BUCKET,
});

// TRANSCRIPTION_PROVIDER=local usa faster-whisper self-hosted (vedi apps/worker/whisper-server/)
// invece dell'API a pagamento di OpenAI — stesso output, richiede però che il server Python
// sia avviato a parte (non gestito dal worker Node).
export const transcriptionProvider: TranscriptionProvider =
  env.TRANSCRIPTION_PROVIDER === "local"
    ? new LocalFasterWhisperProvider(env.LOCAL_WHISPER_URL, env.WORKER_TMP_DIR)
    : new OpenAIWhisperProvider(env.OPENAI_API_KEY, env.WORKER_TMP_DIR);

export const faceTracker = new ReactionCamFaceTracker();
