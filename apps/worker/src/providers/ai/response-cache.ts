import crypto from "node:crypto";
import fsp from "node:fs/promises";
import path from "node:path";
import { env } from "../../env.js";
import { logger } from "../../lib/logger.js";

/**
 * Risposte dell'AI salvate su disco (tmp/ai-cache), per chiave = tutto ciò che entra nella richiesta
 * (modello, istruzioni, testo, immagini). Rifare un render o un passaggio rotto a metà non ripaga
 * l'AI (simo, 2026-10-26: "riprovare una cosa non si ripaga più"); se cambiano trascrizione, prompt o
 * modello, la chiave cambia e si richiede. Un null non si salva: al prossimo giro si riprova.
 *
 * La stessa richiesta rifatta dallo stesso processo entro RETRY_WINDOW_MS è un nuovo tentativo dopo
 * una risposta inutilizzabile (es. il montaggio che "riprova una volta"): lì il disco si salta e la
 * risposta nuova sostituisce quella vecchia.
 */
const RETRY_WINDOW_MS = 15 * 60 * 1000;
const askedAt = new Map<string, number>();

export async function withDiskCache<T>(namespace: string, parts: unknown[], compute: () => Promise<T | null>): Promise<T | null> {
  const key = crypto.createHash("sha1").update(JSON.stringify(parts)).digest("hex").slice(0, 20);
  const file = path.join(env.WORKER_TMP_DIR, "ai-cache", namespace, `${key}.json`);
  const retry = Date.now() - (askedAt.get(file) ?? -Infinity) < RETRY_WINDOW_MS;
  askedAt.set(file, Date.now());
  const cached = retry ? null : await fsp.readFile(file, "utf8").catch(() => null);
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
