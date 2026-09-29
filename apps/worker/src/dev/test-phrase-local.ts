import "dotenv/config";
import type { TranscriptSegment } from "@clipforge/shared";
import { supabase } from "../lib/supabase.js";
import { env } from "../env.js";
import { PhraseLocator } from "../render/intro-moments.js";

/**
 * Prova GRATIS la ricerca di una frase nell'audio col Whisper locale.
 * Uso: tsx src/dev/test-phrase-local.ts <videoId> <sorgente> <inizio clip> <secondi riga> "<frase>"
 */
const [videoId, source, clipStartArg, lineArg, quote] = process.argv.slice(2);
const clipStart = Number(clipStartArg);
const { data } = await supabase.from("transcripts").select("segments").eq("video_id", videoId!).single();
const segments = (data!.segments as TranscriptSegment[]).map((s) => ({ ...s, start: s.start - clipStart, end: s.end - clipStart }));
const locator = new PhraseLocator({ segments, sourceVideoPath: source!, clipStart, clipDuration: 99999, openaiApiKey: env.OPENAI_API_KEY });
const t0 = Date.now();
const found = await locator.locate({ start: Number(lineArg), end: Number(lineArg) + 25, quote: quote! });
await locator.dispose();
console.log(JSON.stringify({ trovata: found, secondi: Math.round((Date.now() - t0) / 1000) }));
