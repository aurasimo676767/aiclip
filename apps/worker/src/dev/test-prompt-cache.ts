import "dotenv/config";
import { getAnthropicClient, cachedSystemPrompt } from "../providers/ai/anthropic-client.js";
import { env } from "../env.js";

/**
 * Prova della cache del prefisso di OpenAI (costa una frazione di centesimo): due chiamate uguali con
 * istruzioni lunghe; la seconda deve leggere dalla cache. Uso: tsx src/dev/test-prompt-cache.ts [modello]
 */
const model = process.argv[2] ?? env.ANTHROPIC_MODEL_CHEAP;
const system = Array.from({ length: 120 }, (_, i) => `Regola ${i + 1}: rispondi sempre in italiano, in modo breve e preciso, senza inventare niente di quello che non sai.`).join("\n");
const client = getAnthropicClient(env.ANTHROPIC_API_KEY);
for (const n of [1, 2]) {
  const m = await client.messages.create({ model, max_tokens: 30, system: cachedSystemPrompt(system), messages: [{ role: "user", content: "Scrivi solo: ok" }] });
  const u = m.usage as typeof m.usage & { cache_read_input_tokens?: number };
  console.log(`chiamata ${n}: input pieno ${u.input_tokens}, dalla cache ${u.cache_read_input_tokens ?? 0}, output ${u.output_tokens}`);
}
