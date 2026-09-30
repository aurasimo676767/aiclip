import Anthropic from "@anthropic-ai/sdk";
import { classifyModelTier, computeModelCostUsd } from "@clipforge/shared";
import { logger } from "../../lib/logger.js";

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

/**
 * `tool_choice` per chiedere un output strutturato tramite strumento. Opus 5.5 ha il ragionamento
 * sempre acceso e rifiuta la scelta forzata ("tool"/"any" → 400): lì si usa "auto", e il prompt di
 * sistema deve dire esplicitamente di rispondere chiamando lo strumento. Gli altri modelli restano
 * forzati.
 */
export function toolChoiceFor(model: string, toolName: string): Anthropic.MessageCreateParams["tool_choice"] {
  if (/opus-5/.test(model)) return { type: "auto" };
  return { type: "tool", name: toolName };
}

/**
 * Scrive nel log il costo REALE di una chiamata (stesso formato delle altre righe "Costo REALE
 * misurato"), per sapere dove vanno davvero i soldi. Aggiunto il 2026-09-30 per gli Shorts, che
 * prima non si misuravano.
 */
export function logAnthropicCost(label: string, model: string, usage: Anthropic.Usage): void {
  const tier = classifyModelTier(model);
  const cache = readCacheUsage(usage);
  const tokens = { input: usage.input_tokens, output: usage.output_tokens, cacheRead: cache.cacheRead, cacheWrite: cache.cacheWrite, calls: 1 };
  logger.info(`Costo REALE misurato — ${label}`, { model, ...tokens, costUsd: tier ? computeModelCostUsd(tier, tokens).toFixed(4) : "?" });
}

/** Quanto si aspetta un batch prima di rinunciare e fare la chiamata normale (a prezzo pieno). */
const BATCH_MAX_WAIT_MS = 2 * 60 * 60 * 1000;

/**
 * Una chiamata a Claude, normale oppure tramite Message Batches: stesso modello e stessa risposta,
 * ma si paga la metà e può metterci da qualche minuto a un'ora (simo, 2026-09-30: "si per i vod").
 * Il batch contiene una sola richiesta; se non finisce entro BATCH_MAX_WAIT_MS o non riesce, si
 * annulla e si rifà la chiamata normale, così il VOD esce comunque.
 *
 * L'SDK installato (0.32.1) ha i batch sotto client.beta.messages.batches: i tipi dei parametri sono
 * quelli "Beta", identici nella forma, da qui i cast.
 */
export async function createMessage(client: Anthropic, params: Anthropic.MessageCreateParamsNonStreaming, opts: { batch?: boolean; label?: string } = {}): Promise<Anthropic.Message> {
  if (!opts.batch) return client.messages.create(params);

  const started = Date.now();
  let batchId: string | undefined;
  try {
    const batch = await client.beta.messages.batches.create({ requests: [{ custom_id: "r1", params: params as never }] });
    batchId = batch.id;
    let status = batch.processing_status;
    let wait = 15_000;
    while (status !== "ended") {
      if (Date.now() - started > BATCH_MAX_WAIT_MS) throw new Error("batch troppo lento");
      await new Promise((r) => setTimeout(r, wait));
      wait = Math.min(wait * 1.5, 60_000);
      status = (await client.beta.messages.batches.retrieve(batchId)).processing_status;
    }
    for await (const item of await client.beta.messages.batches.results(batchId)) {
      if (item.result.type === "succeeded") {
        logger.info("Chiamata via batch completata (prezzo -50%)", { label: opts.label, model: params.model, minuti: ((Date.now() - started) / 60000).toFixed(1) });
        return item.result.message as unknown as Anthropic.Message;
      }
      throw new Error(`batch ${item.result.type}`);
    }
    throw new Error("batch senza risultati");
  } catch (error) {
    logger.warn("Batch non riuscito, si rifà la chiamata normale (prezzo pieno)", {
      label: opts.label,
      batchId,
      error: error instanceof Error ? error.message : String(error),
    });
    if (batchId) await client.beta.messages.batches.cancel(batchId).catch(() => undefined);
    return client.messages.create(params);
  }
}
