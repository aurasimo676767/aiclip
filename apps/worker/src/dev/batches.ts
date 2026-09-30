import "dotenv/config";
import { getAnthropicClient } from "../providers/ai/anthropic-client.js";
import { env } from "../env.js";

/** Ultimi Message Batches su Anthropic con lo stato (per seguire l'analisi dei VOD). Gratis. */
const client = getAnthropicClient(env.ANTHROPIC_API_KEY);
const page = await client.beta.messages.batches.list({ limit: 5 });
for (const b of page.data) console.log(b.id, b.processing_status, "creato", b.created_at, "finito", b.ended_at ?? "-", JSON.stringify(b.request_counts));
