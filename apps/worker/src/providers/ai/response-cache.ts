import crypto from "node:crypto";
import fsp from "node:fs/promises";
import path from "node:path";
import { env } from "../../env.js";
import { logger } from "../../lib/logger.js";

/**
 * Risposte dell'AI salvate su disco (tmp/ai-cache), per chiave = tutto ciò che entra nella richiesta
 * (modello, istruzioni, testo). Rifare lo stesso render per ritoccare le regole che vengono DOPO l'AI
 * (es. match-structure.ts) non ripaga il montaggio; se cambiano trascrizione, prompt o modello, la
 * chiave cambia e si richiede. Un null non si salva: al prossimo giro si riprova.
 */
export async function withDiskCache<T>(namespace: string, parts: unknown[], compute: () => Promise<T | null>): Promise<T | null> {
  const key = crypto.createHash("sha1").update(JSON.stringify(parts)).digest("hex").slice(0, 20);
  const file = path.join(env.WORKER_TMP_DIR, "ai-cache", namespace, `${key}.json`);
  const cached = await fsp.readFile(file, "utf8").catch(() => null);
  if (cached) {
    logger.info("Risposta dell'AI dal disco, niente costo", { cosa: namespace });
    return JSON.parse(cached) as T;
  }
  const value = await compute();
  if (value !== null) {
    await fsp.mkdir(path.dirname(file), { recursive: true });
    await fsp.writeFile(file, JSON.stringify(value));
  }
  return value;
}
