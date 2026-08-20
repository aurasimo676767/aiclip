import { z } from "zod";
import { TEMPLATE_NAMES } from "../types/template.js";

export const zoomEventSchema = z.object({
  time: z.number().nonnegative(),
  action: z.literal("zoom"),
  scale: z.number().min(1).max(3),
});

export const punchInEventSchema = z.object({
  time: z.number().nonnegative(),
  action: z.literal("punch_in"),
  scale: z.number().min(1).max(3),
});

export const highlightWordEventSchema = z.object({
  time: z.number().nonnegative(),
  action: z.literal("highlight_word"),
  word: z.string().min(1).max(40),
});

export const speakerSwitchEventSchema = z.object({
  time: z.number().nonnegative(),
  action: z.literal("speaker_switch"),
  speaker: z.string().min(1).max(40),
});

export const edlEventSchema = z.discriminatedUnion("action", [
  zoomEventSchema,
  punchInEventSchema,
  highlightWordEventSchema,
  speakerSwitchEventSchema,
]);

export const editDecisionListSchema = z.object({
  template: z.enum(TEMPLATE_NAMES),
  events: z.array(edlEventSchema).max(200),
});
