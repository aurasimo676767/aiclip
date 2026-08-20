import { SupabaseStorageProvider } from "../storage/supabase-storage-provider.js";
import { OpenAIWhisperProvider } from "../providers/transcription/openai-whisper-provider.js";
import { CenterCropFaceTracker } from "../face-tracking/center-crop-face-tracker.js";
import { supabase } from "./supabase.js";
import { env } from "../env.js";

export const storageProvider = new SupabaseStorageProvider(supabase, env.STORAGE_BUCKET);
export const transcriptionProvider = new OpenAIWhisperProvider(env.OPENAI_API_KEY, env.WORKER_TMP_DIR);
export const faceTracker = new CenterCropFaceTracker();
