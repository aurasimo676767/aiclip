import "dotenv/config";
import { LocalFasterWhisperProvider } from "../providers/transcription/local-faster-whisper-provider.js";
import { env } from "../env.js";

/** Trascrive un file audio corto col server Whisper locale e stampa lingua e testo. Uso: tsx src/dev/test-whisper-language.ts <audio> [tmpDir] */
const [audio, tmpDir = env.WORKER_TMP_DIR] = process.argv.slice(2);
const t = await new LocalFasterWhisperProvider(env.LOCAL_WHISPER_URL, tmpDir).transcribe(audio!, { fast: true });
console.log(`lingua=${t.language} (richiesta: ${env.TRANSCRIPTION_LANGUAGE})`);
console.log(t.fullText.slice(0, 300));
