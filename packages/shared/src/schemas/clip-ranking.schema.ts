import { z } from "zod";
import { EDITING_STYLES } from "../types/clip.js";
import { editDecisionListSchema } from "./edl.schema.js";

const scoreValue = z.number().int().min(0).max(100);

export const clipScoresSchema = z.object({
  hook: scoreValue,
  retention: scoreValue,
  emotion: scoreValue,
  clarity: scoreValue,
  payoff: scoreValue,
  virality: scoreValue,
});

/**
 * Schema di validazione per l'output del passaggio forte (Claude Sonnet).
 * Deve rispecchiare esattamente il tool JSON schema definito in
 * apps/worker/src/providers/ai/ranking.ts — se cambia uno, aggiorna l'altro.
 */
export const rankedClipSchema = z.object({
  start: z.number().nonnegative(),
  end: z.number().positive(),
  duration: z.number().positive(),
  hook: z.string().min(1).max(200),
  title: z.string().min(1).max(120),
  reason: z.string().min(1).max(400),
  scores: clipScoresSchema,
  editing_style: z.enum(EDITING_STYLES),
  edl: editDecisionListSchema,
  hashtags: z.array(z.string().min(1).max(30)).max(10).default([]),
  caption: z.string().min(1).max(300),
});

export const rankedClipsResponseSchema = z.object({
  clips: z.array(rankedClipSchema).max(30),
});

export type RankedClipsResponse = z.infer<typeof rankedClipsResponseSchema>;
