import "dotenv/config";
import { env } from "../env.js";
import { getAnthropicClient } from "../providers/ai/anthropic-client.js";

/** Verifica che la chiave Anthropic funzioni (credito, permessi) con una richiesta minima a Haiku. Uso: tsx src/dev/check-anthropic.ts */
try {
  const r = await getAnthropicClient(env.ANTHROPIC_API_KEY).messages.create({ model: env.ANTHROPIC_MODEL_CHEAP, max_tokens: 5, messages: [{ role: "user", content: "ok" }] });
  console.log("API ok", r.usage);
} catch (e) {
  console.log("API ERRORE:", e instanceof Error ? e.message.slice(0, 400) : String(e));
}
