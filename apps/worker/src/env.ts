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
  // Il ranking long-form manda l'INTERO transcript di tutti i candidati in una sola chiamata
  // (necessario per titoli/punteggi con contesto reale) — su un VOD di ore sono facilmente
  // 200-260mila token di input, quindi il costo per token conta molto di più che per gli Shorts
  // (finestre piccole). Separato da ANTHROPIC_MODEL_STRONG apposta: se quest'ultimo è impostato
  // su Opus per la qualità degli Shorts (contesto piccolo, costo basso), il long-form non lo
  // eredita automaticamente e resta su un modello più economico di default.
  ANTHROPIC_MODEL_LONGFORM: z.string().default("claude-sonnet-5"),
  // Rifinitura dei tagli di inizio/fine dei video long-form (longform-boundaries.ts): poche righe di
  // transcript attorno a ogni confine, quindi pochi token. Opus perché al test sullo stesso VOD è
  // stato più costante di Sonnet (Sonnet cambiava idea fra un giro e l'altro).
  ANTHROPIC_MODEL_LONGFORM_BOUNDARIES: z.string().default("claude-opus-5-5"),
  // Regia del pannello del gioco negli Shorts (providers/ai/content-focus.ts): quando mostrare il
  // gioco intero o zoomare su quello che indica lo streamer. Una chiamata con ~30 fotogrammi per
  // ogni render. "off" = gioco sempre riempito al centro, nessuna chiamata.
  ANTHROPIC_MODEL_CONTENT_FOCUS: z.string().default("claude-sonnet-5"),
  OPENAI_API_KEY: z.string().min(1),
  // Rifinitura delle copertine con GPT Image (providers/ai/cover-image-ai.ts): la copertina montata
  // coi ritagli fa da bozza e il modello la ridisegna come un grafico. ~5-10 centesimi a copertina a
  // qualità "medium". "off" = resta la copertina montata, nessuna chiamata. Modello provato:
  // gpt-image-2.5-sunburst (lo stesso di ChatGPT a settembre 2026).
  COVER_AI_MODEL: z.string().default("off"),
  COVER_AI_QUALITY: z.enum(["low", "medium", "high"]).default("medium"),
  TRANSCRIPTION_PROVIDER: z.enum(["openai", "local"]).default("openai"),
  // Lingua passata a Whisper. Senza, la deduce dai primi 30 secondi di ogni blocco da ~20 minuti:
  // un VOD che si apriva con un audio in inglese è stato trascritto (e tradotto) in inglese per
  // i primi 20 minuti di parlato italiano (2026-09-25). "auto" = lascia decidere a Whisper.
  TRANSCRIPTION_LANGUAGE: z.string().default("it"),
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
  // Opzionale: alcuni video YouTube (età limitata, "sign in to confirm...") richiedono un
  // account autenticato per essere scaricati con yt-dlp, altrimenti falliscono sempre (anche
  // riprovando) con "Sign in to confirm your age". Se impostato, yt-dlp riusa i cookie di
  // sessione di un browser già loggato su YouTube SU QUESTA MACCHINA (es. "chrome", "edge",
  // "firefox" — stesso valore accettato da yt-dlp per --cookies-from-browser). Su Windows,
  // Chrome può fallire con "Failed to decrypt with DPAPI" (bug noto legato alla nuova
  // App-Bound Encryption di Chrome, yt-dlp/yt-dlp#10927) — Edge di solito non ne risente.
  YT_DLP_COOKIES_FROM_BROWSER: z.string().optional(),
  // Alternativa più affidabile (bypassa del tutto il problema DPAPI sopra): percorso a un file
  // cookies.txt esportato manualmente da un'estensione del browser (es. "Get cookies.txt
  // LOCALLY") mentre si è loggati su YouTube. Se impostato, ha PRECEDENZA su
  // YT_DLP_COOKIES_FROM_BROWSER.
  YT_DLP_COOKIES_FILE: z.string().optional(),
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
