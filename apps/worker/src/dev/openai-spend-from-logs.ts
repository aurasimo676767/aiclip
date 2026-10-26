import "dotenv/config";
import fs from "node:fs";
import path from "node:path";
import { supabase } from "../lib/supabase.js";

/**
 * Spesa OpenAI ricostruita dal log del worker con i prezzi ufficiali (gratis, nessuna chiamata a
 * OpenAI). Più precisa del "costUsd" scritto nel log: conta lo sconto dei batch, il prezzo doppio
 * sopra i 272mila token, le copertine GPT Image e la mappa del VOD (che non ha una riga sua: i suoi
 * token si ricavano da videos.usage_stats togliendo confini e titoli già contati).
 * Uso: tsx src/dev/openai-spend-from-logs.ts <AAAA-MM-GG> [video_id del VOD]
 * Prezzi controllati il 2026-10-25 su developers.openai.com/api/docs/pricing.
 */
const PRICES: Record<string, { input: number; cached: number; output: number; longInput: number; longCached: number; longOutput: number }> = {
  "gpt-6.1-sol": { input: 2, cached: 0.1, output: 10, longInput: 4, longCached: 0.2, longOutput: 15 },
  "gpt-6-luna": { input: 0.1, cached: 0.01, output: 0.5, longInput: 0.2, longCached: 0.02, longOutput: 0.75 },
};
const IMAGE = { text: 5, image: 8, output: 30 };
const LONG_CONTEXT_TOKENS = 272_000;

const [day, vodId] = process.argv.slice(2);
if (!day) throw new Error("Uso: tsx src/dev/openai-spend-from-logs.ts <AAAA-MM-GG> [video_id]");
const lines = fs.readFileSync(path.join("tmp", "logs", `worker-${day}.log`), "utf8").split("\n");

const json = (line: string) => {
  try {
    return JSON.parse(line.slice(line.indexOf("{")));
  } catch {
    return null;
  }
};
function textCost(model: string, input: number, cached: number, output: number, batch: boolean): number {
  const p = PRICES[model];
  if (!p) return 0;
  const long = input + cached > LONG_CONTEXT_TOKENS;
  const usd = (input * (long ? p.longInput : p.input) + cached * (long ? p.longCached : p.cached) + output * (long ? p.longOutput : p.output)) / 1e6;
  return batch ? usd / 2 : usd;
}

const byLabel = new Map<string, { calls: number; usd: number }>();
const add = (label: string, usd: number) => {
  const x = byLabel.get(label) ?? { calls: 0, usd: 0 };
  x.calls++;
  x.usd += usd;
  byLabel.set(label, x);
};
const counted = { input: 0, output: 0 };
let lastBatchAt = -Infinity;

for (const line of lines) {
  const at = Date.parse(line.slice(1, 25));
  if (line.includes("Chiamata via batch completata")) lastBatchAt = at;
  if (line.includes("Costo REALE misurato")) {
    const d = json(line);
    // La riga dei confini long-form non scrive il modello: è sempre quello forte (Sol).
    if (d && !d.model) d.model = "gpt-6.1-sol";
    if (!d || !PRICES[d.model]) continue;
    const label = line.slice(line.indexOf("—") + 2, line.indexOf("{")).trim();
    const batch = at - lastBatchAt < 2000;
    add(`${label}${batch ? " (batch)" : ""}`, textCost(d.model, d.input, d.cacheRead ?? 0, d.output, batch));
    if (/confini long-form|metadati long-form/.test(label)) {
      counted.input += d.input + (d.cacheRead ?? 0);
      counted.output += d.output;
    }
  }
  if (line.includes("Copertina rifinita con GPT Image")) {
    const u = json(line)?.usage;
    if (!u) continue;
    const text = u.input_tokens_details?.text_tokens ?? 0;
    const image = u.input_tokens_details?.image_tokens ?? 0;
    add("copertina GPT Image", (text * IMAGE.text + image * IMAGE.image + u.output_tokens * IMAGE.output) / 1e6);
  }
  const whisper = line.match(/"whisperOpenaiSecondi":"?([\d.]+)/);
  if (whisper) add("Whisper OpenAI (ripiego)", (Number(whisper[1]) / 60) * 0.006);
}

if (vodId) {
  const { data } = await supabase.from("videos").select("usage_stats").eq("id", vodId).single();
  const sol = (data?.usage_stats as { tokens?: Record<string, { input: number; output: number; cacheRead: number }> } | null)?.tokens?.sol;
  if (sol) {
    const input = sol.input + sol.cacheRead - counted.input;
    const output = sol.output - counted.output;
    const batchFailed = lines.some((l) => l.includes("Batch non riuscito") && l.includes("mappa del VOD"));
    add(`mappa del VOD${batchFailed ? "" : " (batch)"}`, textCost("gpt-6.1-sol", input, 0, output, !batchFailed));
  }
}

let total = 0;
for (const [label, x] of [...byLabel.entries()].sort((a, b) => b[1].usd - a[1].usd)) {
  total += x.usd;
  console.log(`$${x.usd.toFixed(4)}  ${x.calls}x  ${label}`);
}
console.log(`TOTALE ${day}: $${total.toFixed(4)}`);
