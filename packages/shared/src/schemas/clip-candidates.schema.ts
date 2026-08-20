import { z } from "zod";

/**
 * Schema di validazione per l'output del passaggio economico (Claude Haiku).
 * Deve rispecchiare esattamente il tool JSON schema definito in
 * apps/worker/src/providers/ai/candidates.ts — se cambia uno, aggiorna l'altro.
 */
export const clipCandidateSchema = z.object({
  start: z.number().nonnegative(),
  end: z.number().positive(),
  hook: z.string().min(1).max(200),
  reason: z.string().min(1).max(300),
});

export const clipCandidatesResponseSchema = z.object({
  candidates: z.array(clipCandidateSchema).max(50),
});

export type ClipCandidatesResponse = z.infer<typeof clipCandidatesResponseSchema>;
