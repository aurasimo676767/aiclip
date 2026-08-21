import { logger } from "./logger.js";

/**
 * Riprova `fn` un paio di volte con backoff se fallisce per un errore di rete transitorio
 * (es. "fetch failed" — blip momentaneo di connessione, non un errore applicativo). Usato
 * per le scritture Supabase che chiudono lavoro costoso a monte (trascrizione + AI): un
 * singolo blip di rete non deve buttare via minuti di elaborazione già pagata.
 */
// PromiseLike, non Promise: i query builder di supabase-js sono "thenable" ma non vere
// istanze Promise (mancano .catch/.finally) — un vincolo su Promise<T> li rifiuterebbe.
export async function withNetworkRetry<T>(fn: () => PromiseLike<T>, label: string): Promise<T> {
  const attempts = 3;
  const delaysMs = [2000, 5000];

  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      return await fn();
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const isLastAttempt = attempt === attempts;
      if (isLastAttempt) throw err;

      logger.warn(`${label}: tentativo ${attempt} fallito, ritento`, { error: message });
      await new Promise((resolve) => setTimeout(resolve, delaysMs[attempt - 1]));
    }
  }

  throw new Error("unreachable");
}
