import { R2StorageProvider } from "../storage/r2-storage-provider.js";
import { OpenAIWhisperProvider } from "../providers/transcription/openai-whisper-provider.js";
import { ReactionCamFaceTracker } from "../face-tracking/reaction-cam-face-tracker.js";
import { env } from "../env.js";

export const storageProvider = new R2StorageProvider({
  accountId: env.R2_ACCOUNT_ID,
  accessKeyId: env.R2_ACCESS_KEY_ID,
  secretAccessKey: env.R2_SECRET_ACCESS_KEY,
  bucket: env.R2_BUCKET,
});
export const transcriptionProvider = new OpenAIWhisperProvider(env.OPENAI_API_KEY, env.WORKER_TMP_DIR);
export const faceTracker = new ReactionCamFaceTracker();
