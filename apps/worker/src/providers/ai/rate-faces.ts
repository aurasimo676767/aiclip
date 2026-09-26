import fsp from "node:fs/promises";
import sharp from "sharp";
import type Anthropic from "@anthropic-ai/sdk";
import type { ModelTokenUsage } from "@clipforge/shared";
import { getAnthropicClient, toolChoiceFor } from "./anthropic-client.js";
import { logger } from "../../lib/logger.js";

/**
 * Giudica ritagli di persone per la libreria delle copertine: se sono puliti e utilizzabili e che
 * espressione hanno. NON chiede e NON deduce mai CHI è la persona: il nome lo mette simo.
 * ~0,005 $ ogni 8 ritagli con Haiku.
 */

export interface FaceRating {
  usable: boolean;
  issues: string[];
  expression: string;
  intensity: number;
}

export const FACE_EXPRESSIONS = ["shock", "urlo", "risata", "rabbia", "paura", "mani_in_testa", "sospetto", "sorriso", "neutra"] as const;

const TOOL = "rate_faces";
const BATCH = 8;

const SYSTEM = `Ricevi ritagli di persone (sfondo rimosso, mostrati su grigio) da usare in copertine YouTube. Per ogni ritaglio valuta SOLO se è usabile e che espressione ha. Non identificare mai le persone e non indovinare chi sono.

usable = true solo se TUTTO questo è vero:
- c'è UNA sola persona reale (niente seconda faccia o pezzi di altre persone attaccati);
- viso ben visibile e non troppo piccolo, non coperto (niente bende, maschere, X, mani davanti alla bocca);
- non è modificato in modo grottesco: niente capelli/corpi cartoon, teste incollate su animali, filtri pesanti, disegni;
- non ci sono pezzi di scritte, loghi, emoji, adesivi o grafica attaccati al ritaglio;
- il ritaglio è pulito: non mancano pezzi di testa, non ci sono chiazze di sfondo attorno, i bordi seguono la persona.
Le cuffie, gli occhiali, i cappelli e i vestiti normali vanno bene.

issues: elenco breve dei problemi (in italiano), vuoto se usable.
expression: una fra ${FACE_EXPRESSIONS.map((e) => `"${e}"`).join(", ")} (shock = stupore a bocca aperta).
intensity: 1-5, quanto è forte ed esagerata l'espressione (5 = da copertina, esagerata).

Rispondi chiamando lo strumento ${TOOL} con un elemento per ogni ritaglio, nell'ordine.`;

const toolSchema = {
  name: TOOL,
  description: "Valutazione dei ritagli, nell'ordine in cui sono stati mostrati.",
  input_schema: {
    type: "object" as const,
    properties: {
      faces: {
        type: "array",
        items: {
          type: "object",
          properties: {
            index: { type: "integer" },
            usable: { type: "boolean" },
            issues: { type: "array", items: { type: "string" } },
            expression: { type: "string", enum: [...FACE_EXPRESSIONS] },
            intensity: { type: "integer", minimum: 1, maximum: 5 },
          },
          required: ["index", "usable", "issues", "expression", "intensity"],
        },
      },
    },
    required: ["faces"],
  },
};

/** Giudica i PNG indicati; ritorna una mappa percorso -> giudizio (i ritagli non giudicati mancano). */
export async function rateFaceImages(
  pngPaths: string[],
  options: { apiKey: string; model: string },
): Promise<{ ratings: Map<string, FaceRating>; usage: ModelTokenUsage }> {
  const client = getAnthropicClient(options.apiKey);
  const usage: ModelTokenUsage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, calls: 0 };
  const ratings = new Map<string, FaceRating>();

  for (let i = 0; i < pngPaths.length; i += BATCH) {
    const batch = pngPaths.slice(i, i + BATCH);
    const content: Anthropic.MessageParam["content"] = [];
    for (const [j, p] of batch.entries()) {
      const img = await sharp(await fsp.readFile(p)).resize(320, 320, { fit: "inside" }).flatten({ background: "#808080" }).jpeg({ quality: 80 }).toBuffer();
      content.push({ type: "text", text: `Ritaglio ${j}:` });
      content.push({ type: "image", source: { type: "base64", media_type: "image/jpeg", data: img.toString("base64") } });
    }
    try {
      const msg = await client.messages.create({
        model: options.model,
        max_tokens: 2000,
        system: SYSTEM,
        messages: [{ role: "user", content }],
        tools: [toolSchema],
        tool_choice: toolChoiceFor(options.model, TOOL),
      });
      usage.calls++;
      usage.input += msg.usage.input_tokens;
      usage.output += msg.usage.output_tokens;
      const tool = msg.content.find((b): b is Anthropic.ToolUseBlock => b.type === "tool_use");
      for (const r of (tool?.input as { faces?: Array<FaceRating & { index: number }> })?.faces ?? []) {
        const p = batch[r.index];
        if (p) ratings.set(p, { usable: r.usable, issues: r.issues ?? [], expression: r.expression, intensity: r.intensity });
      }
    } catch (error) {
      logger.warn("Giudizio facce fallito per un gruppo", { error: error instanceof Error ? error.message : String(error) });
    }
  }
  return { ratings, usage };
}
