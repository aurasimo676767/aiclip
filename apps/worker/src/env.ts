import "dotenv/config";
import { z } from "zod";

const envSchema = z.object({
  SUPABASE_URL: z.string().url(),
  SUPABASE_SERVICE_ROLE_KEY: z.string().min(1),
  STORAGE_BUCKET: z.string().min(1).default("clipforge-media"),
  ANTHROPIC_API_KEY: z.string().min(1),
  ANTHROPIC_MODEL_CHEAP: z.string().default("claude-haiku-4-5-20251001"),
  ANTHROPIC_MODEL_STRONG: z.string().default("claude-sonnet-5"),
  OPENAI_API_KEY: z.string().min(1),
  WORKER_TMP_DIR: z.string().default("./tmp"),
  QUEUE_POLL_INTERVAL_MS: z.coerce.number().int().positive().default(3000),
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
