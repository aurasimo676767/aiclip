import { z } from "zod";
import { CLIP_BADGES } from "../types/clip.js";
import { clipScoresSchema } from "./clip-ranking.schema.js";

/**
 * Schema di validazione per l'output del passaggio forte long-form (Claude Sonnet).
 * Deve rispecchiare esattamente il tool JSON schema definito in
 * apps/worker/src/providers/ai/longform-ranking.ts — se cambia uno, aggiorna l'altro.
 */
export const rankedLongformClipSchema = z.object({
  start: z.number().nonnegative(),
  end: z.number().positive(),
  duration: z.number().positive(),
  title: z.string().min(1).max(100),
  hook: z.string().min(1).max(200),
  reason: z.string().min(1).max(400),
  scores: clipScoresSchema,
  hashtags: z.array(z.string().min(1).max(30)).max(10).default([]),
  caption: z.string().min(1).max(1000),
  badges: z.array(z.enum(CLIP_BADGES)).max(5).default([]),
});

export const rankedLongformClipsResponseSchema = z.object({
  clips: z.array(rankedLongformClipSchema).max(15),
});

export type RankedLongformClipsResponse = z.infer<typeof rankedLongformClipsResponseSchema>;
