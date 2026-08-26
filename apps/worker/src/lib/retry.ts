import { logger } from "./logger.js";

// Forma comune a TUTTE le risposte di @supabase/postgrest-js (select/update/insert/rpc).
// status è SEMPRE presente e vale 0 solo in un caso preciso: il fetch stesso è fallito
// (DNS/connessione/TLS) prima di ricevere una risposta HTTP — mai per un vero errore
// applicativo (quelli hanno uno status HTTP reale, es. 404/409/500). Vedi PostgrestBuilder.ts
// (versione installata 2.112.3), righe 388-456: per POST/PATCH (update/insert, la maggior
// parte delle scritture di questo worker) il retry interno di postgrest-js è disabilitato
// (limitato a GET/HEAD) e il fallimento di fetch viene convertito in un risultato RISOLTO con
// status:0 invece di far rigettare la promise — quindi un semplice try/catch su `await fn()`
// non lo intercetta MAI. Questo bug è stato osservato in produzione: "Aggiornamento status
// render_job fallito: TypeError: fetch failed" ripetuto molte volte, un blip di rete che
// falliva al primo tentativo nonostante il "retry" apparente.
interface PostgrestLikeResult {
  status: number;
  error: { message?: string } | null;
}

/**
 * Riprova `fn` se il risultato indica un errore di RETE transitorio (status:0, vedi sopra),
 * non un errore applicativo. Usato per le scritture Supabase che chiudono lavoro costoso a
 * monte (trascrizione + AI): un singolo blip di rete non deve buttare via minuti di
 * elaborazione già pagata.
 */
// PromiseLike, non Promise: i query builder di supabase-js sono "thenable" ma non vere
// istanze Promise (mancano .catch/.finally) — un vincolo su Promise<T> li rifiuterebbe.
export async function withNetworkRetry<T extends PostgrestLikeResult>(fn: () => PromiseLike<T>, label: string): Promise<T> {
  // Prima 5 tentativi su ~37s totali: non bastava per un'interruzione di rete di un minuto
  // abbondante (osservata in pratica alla fine di una pipeline lunga — trascrizione+AI già
  // completate, persa solo per un blip alla scrittura finale dello stato). Copriamo ora ~1m30s.
  const attempts = 6;
  const delaysMs = [3000, 6000, 12000, 24000, 45000];

  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      const result = await fn();
      const isNetworkFailure = result.status === 0;
      const isLastAttempt = attempt === attempts;
      if (!isNetworkFailure || isLastAttempt) {
        return result;
      }

      logger.warn(`${label}: tentativo ${attempt} fallito (errore di rete), ritento`, { error: result.error?.message });
      await new Promise((resolve) => setTimeout(resolve, delaysMs[attempt - 1]));
    } catch (err) {
      // Rete di sicurezza per il caso (raro con shouldThrowOnError=false, mai usato qui) in
      // cui fn() rigetti davvero invece di risolvere con status:0.
      const message = err instanceof Error ? err.message : String(err);
      const isLastAttempt = attempt === attempts;
      if (isLastAttempt) throw err;

      logger.warn(`${label}: tentativo ${attempt} fallito, ritento`, { error: message });
      await new Promise((resolve) => setTimeout(resolve, delaysMs[attempt - 1]));
    }
  }

  throw new Error("unreachable");
}
