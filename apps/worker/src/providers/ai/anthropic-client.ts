import Anthropic from "@anthropic-ai/sdk";

let client: Anthropic | null = null;

export function getAnthropicClient(apiKey: string): Anthropic {
  if (!client) {
    client = new Anthropic({ apiKey });
  }
  return client;
}

/**
 * Blocco `system` con `cache_control` per il caching lato server di Anthropic: il prompt di
 * sistema è identico a ogni chiamata (candidati/ranking, Shorts e long-form) — senza caching
 * viene rifatturato per intero ogni volta, anche quando più chiamate ravvicinate per lo stesso
 * video condividono esattamente lo stesso testo. Con questo, le chiamate successive entro la TTL
 * (5 minuti di default) pagano ~1/10 sui token del prefisso cachato invece del prezzo pieno.
 *
 * L'SDK installato (@anthropic-ai/sdk 0.32.1) è troppo vecchio per avere `cache_control` nei tipi
 * di TextBlockParam (all'epoca era ancora nel namespace beta separato client.beta.promptCaching,
 * poi diventato stabile su client.messages senza bisogno di beta header) — il campo è comunque
 * accettato e onorato dalla vera API REST, quindi lo aggiungiamo con un cast mirato invece di fare
 * un upgrade dell'intero SDK solo per questo. Se aggiorni l'SDK in futuro, questo cast si può
 * togliere e usare il tipo vero.
 */
export function cachedSystemPrompt(text: string): Anthropic.TextBlockParam[] {
  return [{ type: "text", text, cache_control: { type: "ephemeral" } } as Anthropic.TextBlockParam];
}

/**
 * Legge cache_read_input_tokens/cache_creation_input_tokens da message.usage — assenti dai tipi
 * di questo SDK (vedi cachedSystemPrompt) ma presenti nella risposta REST reale quando il caching
 * si attiva. 0 se il caching non si è attivato per quella chiamata (prefisso troppo corto, TTL
 * scaduta, ecc.) — non è un errore, va gestito come "nessuno sconto per questa chiamata".
 */
export function readCacheUsage(usage: Anthropic.Usage): { cacheRead: number; cacheWrite: number } {
  const raw = usage as Anthropic.Usage & { cache_read_input_tokens?: number; cache_creation_input_tokens?: number };
  return { cacheRead: raw.cache_read_input_tokens ?? 0, cacheWrite: raw.cache_creation_input_tokens ?? 0 };
}
