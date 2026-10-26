import OpenAI from "openai";
import { env } from "../env.js";

// Stato di un batch OpenAI (gratis). Uso: tsx src/dev/openai-batch-status.ts <batch_id>
const openai = new OpenAI({ apiKey: env.OPENAI_API_KEY });
const b = await openai.batches.retrieve(process.argv[2]!);
const minutes = ((Date.now() / 1000 - b.created_at) / 60).toFixed(1);
console.log(JSON.stringify({ id: b.id, status: b.status, minuti: minutes, counts: b.request_counts, errors: b.errors?.data }));
