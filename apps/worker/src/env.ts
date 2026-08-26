import "dotenv/config";
import { setDefaultResultOrder } from "node:dns";
import { z } from "zod";

// Su alcune reti Windows la risoluzione DNS preferisce IPv6 anche quando la rotta IPv6
// non è realmente raggiungibile, causando "TypeError: fetch failed" intermittenti verso
// Supabase/Anthropic/OpenAI. Forzare IPv4 come preferenza risolve il problema senza
// impatto su Linux/produzione (dove IPv6 funziona correttamente ma questo flag è comunque innocuo).
setDefaultResultOrder("ipv4first");

const envSchema = z.object({
  SUPABASE_URL: z.string().url(),
  SUPABASE_SERVICE_ROLE_KEY: z.string().min(1),
  R2_ACCOUNT_ID: z.string().min(1),
  R2_ACCESS_KEY_ID: z.string().min(1),
  R2_SECRET_ACCESS_KEY: z.string().min(1),
  R2_BUCKET: z.string().min(1),
  ANTHROPIC_API_KEY: z.string().min(1),
  ANTHROPIC_MODEL_CHEAP: z.string().default("claude-haiku-4-5-20251001"),
  ANTHROPIC_MODEL_STRONG: z.string().default("claude-sonnet-5"),
  OPENAI_API_KEY: z.string().min(1),
  TRANSCRIPTION_PROVIDER: z.enum(["openai", "local"]).default("openai"),
  LOCAL_WHISPER_URL: z.string().default("http://127.0.0.1:8765"),
  GOOGLE_CLIENT_ID: z.string().min(1),
  GOOGLE_CLIENT_SECRET: z.string().min(1),
  WORKER_TMP_DIR: z.string().default("./tmp"),
  QUEUE_POLL_INTERVAL_MS: z.coerce.number().int().positive().default(3000),
  // Render (face-tracking ONNX + ffmpeg) è CPU-only, non tocca la GPU (quella la usa solo whisper)
  // -> nessun conflitto di risorse a farne girare più di uno insieme. Default 2, verificato con
  // l'utente su un i7-12700F (12 core/20 thread): reggerebbe anche di più, ma partiamo prudenti.
  RENDER_CONCURRENCY: z.coerce.number().int().positive().default(2),
  // Video in analisi (download+trascrizione+AI) in parallelo: risolve un video bloccato in
  // retry automatico che altrimenti, restando in testa alla coda, blocca anche gli altri video
  // dello stesso batch dietro di lui. La trascrizione locale (whisper, GPU) resta comunque
  // serializzata al suo interno (vedi LocalFasterWhisperProvider) indipendentemente da questo
  // valore, quindi aumentarlo non rischia OOM sulla GPU — parallelizza solo le altre fasi
  // (download, ranking AI, scritture DB).
  VIDEO_CONCURRENCY: z.coerce.number().int().positive().default(2),
});

const parsed = envSchema.safeParse(process.env);

if (!parsed.success) {
  console.error("[worker] Variabili d'ambiente mancanti o non valide:");
  for (const issue of parsed.error.issues) {
    console.error(`  - ${issue.path.join(".")}: ${issue.message}`);
  }
  throw new Error("Configurazione ambiente non valida. Controlla il tuo file .env rispetto a .env.example.");
}

export const env = parsed.data;
