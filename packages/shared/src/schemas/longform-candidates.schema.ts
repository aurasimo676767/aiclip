import { z } from "zod";

/**
 * Schema di validazione per l'output del passaggio economico long-form (Claude Haiku).
 * Deve rispecchiare esattamente il tool JSON schema definito in
 * apps/worker/src/providers/ai/longform-candidates.ts — se cambia uno, aggiorna l'altro.
 */
export const longformCandidateSchema = z.object({
  start: z.number().nonnegative(),
  end: z.number().positive(),
  topic: z.string().min(1).max(200),
});

export const longformCandidatesResponseSchema = z.object({
  candidates: z.array(longformCandidateSchema).max(30),
});

export type LongformCandidatesResponse = z.infer<typeof longformCandidatesResponseSchema>;
