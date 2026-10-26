import "@anthropic-ai/sdk";
import OpenAI, { toFile } from "openai";
import { env } from "../env.js";

// Prova gratuita: carica un file da 1 riga sulla Files API (purpose batch) e lo cancella subito,
// con le stesse impostazioni del ponte (timeout 20 minuti) e l'SDK Anthropic già caricato.
const openai = new OpenAI({ apiKey: env.OPENAI_API_KEY, timeout: 20 * 60 * 1000, maxRetries: 0 });
try {
  const file = await openai.files.create({ file: await toFile(Buffer.from('{"a":1}\n'), "prova.jsonl"), purpose: "batch" });
  console.log("upload ok", file.id, file.status);
  await openai.files.del(file.id);
  console.log("cancellato");
} catch (error) {
  const e = error as Error & { cause?: unknown };
  console.log("ERRORE", e.constructor.name, e.message);
  console.log("causa:", e.cause instanceof Error ? `${e.cause.name}: ${e.cause.message}\n${e.cause.stack?.split("\n").slice(0, 6).join("\n")}` : e.cause);
}
