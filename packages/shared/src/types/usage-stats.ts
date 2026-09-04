import { MODEL_PRICING_USD_PER_MTOK } from "../constants/pipeline.js";

export type ModelUsageKey = keyof typeof MODEL_PRICING_USD_PER_MTOK;

export interface ModelTokenUsage {
  input: number;
  output: number;
  calls: number;
  /** Token del prefisso cachato letti dalla cache (~1/10 del prezzo input normale). 0 se il caching non si è attivato. */
  cacheRead: number;
  /** Token scritti in cache la prima volta (~1,25x il prezzo input normale, poi riletti a sconto dalle chiamate successive). */
  cacheWrite: number;
}

/**
 * Statistiche reali (non stimate) di uso AI e tempi di elaborazione, salvate su videos.usage_stats
 * a fine pipeline dal worker (vedi process-video-job.ts) e lette dal sito per mostrare all'utente
 * quanto è costata/durata davvero l'elaborazione di questo video specifico.
 */
export interface VideoUsageStats {
  tokens: Partial<Record<ModelUsageKey, ModelTokenUsage>>;
  costUsd: Partial<Record<ModelUsageKey, number>> & { total: number };
  stages: {
    downloadSeconds?: number;
    transcriptionSeconds?: number;
    aiAnalysisSeconds?: number;
  };
}

/**
 * Mappa un ID modello Anthropic effettivo (es. "claude-opus-5", "claude-haiku-4-5-20251001") al
 * livello di prezzo corrispondente. I modelli usati sono configurabili in .env
 * (ANTHROPIC_MODEL_CHEAP/STRONG/LONGFORM) quindi non si può assumere un ID fisso — si classifica
 * per sottostringa. Ritorna null per un ID non riconosciuto (nuovo modello non ancora in
 * MODEL_PRICING_USD_PER_MTOK): chi chiama deve gestire questo caso senza inventare un costo.
 */
export function classifyModelTier(modelId: string): ModelUsageKey | null {
  const lower = modelId.toLowerCase();
  if (lower.includes("haiku")) return "haiku";
  if (lower.includes("opus")) return "opus";
  if (lower.includes("sonnet")) return "sonnet";
  return null;
}

// Moltiplicatori standard Anthropic per il caching: una lettura dalla cache costa il 10% del
// prezzo input normale, una scrittura (la prima volta che un prefisso viene cachato) il 125%.
const CACHE_READ_MULTIPLIER = 0.1;
const CACHE_WRITE_MULTIPLIER = 1.25;

/** Costo in $ per un singolo livello dati i token effettivi (cache inclusa) — stessa formula usata dal worker e dal sito. */
export function computeModelCostUsd(model: ModelUsageKey, usage: ModelTokenUsage): number {
  const pricing = MODEL_PRICING_USD_PER_MTOK[model];
  return (
    (usage.input / 1e6) * pricing.input +
    (usage.output / 1e6) * pricing.output +
    (usage.cacheRead / 1e6) * pricing.input * CACHE_READ_MULTIPLIER +
    (usage.cacheWrite / 1e6) * pricing.input * CACHE_WRITE_MULTIPLIER
  );
}
