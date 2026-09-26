import { CLIP_DURATION_TARGET, overallScore, type RankedClip, type TranscriptSegment } from "@clipforge/shared";
import { logger } from "../lib/logger.js";

/**
 * Pausa massima tollerata DENTRO una clip in cui nessuno parla. Non è "silenzio audio" (quello lo
 * toglie già il render via silencedetect, vedi silence.ts): in una live di gaming il gioco continua
 * a fare rumore mentre nessuno parla, quindi quei buchi NON vengono rilevati come silenzio e
 * restavano dentro la clip. Il transcript invece dice esattamente quando qualcuno sta parlando.
 * Un buco più lungo di così, in uno Short da 30 secondi, è tempo morto — e quasi sempre segna
 * anche un cambio di discorso (verificato su clip reali: dopo un buco di 5-8s partiva un
 * argomento completamente diverso da quello del titolo).
 */
const MAX_INTERNAL_GAP_SECONDS = 2.5;

/**
 * Sovrapposizione massima tollerata tra due clip, come frazione della più corta. Osservato in
 * pratica: due clip suggerite sullo stesso video condividevano 13 secondi su ~28, cioè metà dello
 * stesso contenuto pubblicato due volte con due titoli diversi.
 */
const MAX_OVERLAP_RATIO = 0.3;

/**
 * Respiro prima della prima parola del gancio. Misurato il 2026-09-26 sugli ultimi 30 Shorts: TUTTI
 * partivano a 0,00 s dalla prima parola (inizio del segmento Whisper), e Whisper segna spesso la
 * parola un filo in ritardo, quindi l'attacco si perdeva ("parte a scatto", simo). simo vuole
 * "mezzo secondo MASSIMO prima" della frase che aggancia.
 */
const HOOK_LEAD_SECONDS = 0.4;

const normWord = (w: string) => w.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "");

/**
 * Rete di sicurezza lato codice sui confini delle clip Shorts: il prompt di ranking.ts chiede già
 * all'AI di partire sul gancio e chiudere sul payoff, ma un prompt può essere disatteso e in
 * pratica lo è stato (clip che partono a metà frase, che contengono buchi di 5-8 secondi in cui
 * nessuno parla, che finiscono a metà parola, o che si sovrappongono tra loro).
 *
 * Qui i confini vengono corretti in modo deterministico usando il transcript:
 * 1. start/end agganciati ai confini delle frasi (mai a metà di un segmento parlato);
 * 2. clip troncata al primo buco troppo lungo al suo interno;
 * 3. clip troppo corte dopo la correzione scartate;
 * 4. clip che si sovrappongono troppo tra loro deduplicate (tiene la meglio piazzata).
 */
export function sanitizeShortClips(clips: RankedClip[], segments: TranscriptSegment[], videoId: string): RankedClip[] {
  if (segments.length === 0) return clips;

  const sorted = [...segments].sort((a, b) => a.start - b.start);
  const fixed: RankedClip[] = [];

  for (const clip of clips) {
    const result = fixBoundaries(clip, sorted);
    if (!result) {
      logger.warn("Clip Shorts scartata: dopo la correzione dei confini restava troppo corta", {
        videoId,
        hook: clip.hook,
        originalStart: clip.start,
        originalEnd: clip.end,
      });
      continue;
    }
    if (result.start !== clip.start || result.end !== clip.end) {
      logger.info("Confini clip Shorts corretti sul transcript", {
        videoId,
        hook: clip.hook,
        from: `${clip.start.toFixed(1)}-${clip.end.toFixed(1)}`,
        to: `${result.start.toFixed(1)}-${result.end.toFixed(1)}`,
      });
    }
    fixed.push(result);
  }

  return dropOverlapping(fixed, videoId);
}

/**
 * Aggancia start/end ai confini delle frasi del transcript e tronca la clip al primo buco troppo
 * lungo. Ritorna null se quel che resta è sotto la durata minima.
 */
function fixBoundaries(clip: RankedClip, segments: TranscriptSegment[]): RankedClip | null {
  // START: se cade dentro una frase, si arretra all'inizio di QUELLA frase (una clip non deve
  // mai partire a metà di una parola/pensiero); se cade in un buco tra due frasi, si avanza
  // all'inizio della prossima (niente tempo morto in apertura, che uccide la ritenzione).
  const startSegment = segments.find((s) => clip.start >= s.start && clip.start < s.end);
  const nextSegment = segments.find((s) => s.start >= clip.start);
  let start = startSegment ? startSegment.start : nextSegment ? nextSegment.start : clip.start;

  // Precisione alla PAROLA: se le prime parole del gancio (campo hook, "le prime parole esatte con
  // cui la clip si apre") si trovano vicino all'inizio scelto dall'AI, si parte da lì, anche a metà
  // di un segmento Whisper: prima si tornava all'inizio del segmento, a volte secondi prima del
  // gancio. Poi mezzo secondo scarso di respiro, senza prendere la coda della parola precedente.
  const words = segments.flatMap((seg) => seg.words ?? []).sort((a, b) => a.start - b.start);
  const hookWords = clip.hook.split(/\s+/).map(normWord).filter(Boolean).slice(0, 3);
  let first = -1;
  if (hookWords.length > 0) {
    first = words.findIndex(
      (w, i) => Math.abs(w.start - clip.start) <= 4 && hookWords.every((h, k) => normWord(words[i + k]?.word ?? "") === h),
    );
  }
  if (first < 0) first = words.findIndex((w) => w.end > start + 0.05);
  if (first >= 0) {
    const previousEnd = first > 0 ? words[first - 1]!.end : 0;
    start = Math.max(0, previousEnd + 0.02, words[first]!.start - HOOK_LEAD_SECONDS);
    // Il respiro non deve superare il mezzo secondo né finire dentro la parola precedente.
    start = Math.min(start, words[first]!.start);
  }

  const inside = segments.filter((s) => s.end > start + 0.05 && s.start < clip.end);
  if (inside.length === 0) return null;

  // Primo buco troppo lungo tra due frasi consecutive: la clip finisce lì, prima del tempo morto.
  let end = inside[inside.length - 1]!.end;
  for (let i = 1; i < inside.length; i++) {
    const gap = inside[i]!.start - inside[i - 1]!.end;
    if (gap > MAX_INTERNAL_GAP_SECONDS) {
      end = inside[i - 1]!.end;
      break;
    }
  }

  // END: se l'AI aveva chiuso dentro una frase, la si completa (mai tagliare a metà parola),
  // ma solo finché si resta sotto il tetto di durata.
  const endSegment = segments.find((s) => clip.end > s.start && clip.end < s.end);
  if (endSegment && endSegment.end <= end && endSegment.end - start <= CLIP_DURATION_TARGET.hardMax) {
    end = Math.max(end, endSegment.end);
  }

  // Tetto di durata: si taglia sull'ultimo confine di frase che ci sta dentro, non a metà frase.
  if (end - start > CLIP_DURATION_TARGET.hardMax) {
    const limit = start + CLIP_DURATION_TARGET.hardMax;
    const lastFitting = inside.filter((s) => s.end <= limit).pop();
    end = lastFitting ? lastFitting.end : limit;
  }

  const duration = end - start;
  if (duration < CLIP_DURATION_TARGET.hardMin) return null;

  return {
    ...clip,
    start,
    end,
    duration,
    edl: { ...clip.edl, events: clip.edl.events.filter((event) => event.time >= start && event.time <= end) },
  };
}

/**
 * Scarta le clip che coprono in buona parte lo stesso intervallo di una già tenuta: a parità di
 * contenuto resta quella con il punteggio migliore, non quella che capita prima nella lista.
 */
function dropOverlapping(clips: RankedClip[], videoId: string): RankedClip[] {
  const byScore = [...clips].sort((a, b) => overallScore(b.scores) - overallScore(a.scores));
  const kept: RankedClip[] = [];

  for (const clip of byScore) {
    const clash = kept.find((k) => {
      const overlap = Math.min(k.end, clip.end) - Math.max(k.start, clip.start);
      if (overlap <= 0) return false;
      const shorter = Math.min(k.duration, clip.duration);
      return shorter > 0 && overlap / shorter > MAX_OVERLAP_RATIO;
    });
    if (clash) {
      logger.warn("Clip Shorts scartata: si sovrappone troppo a un'altra già tenuta", {
        videoId,
        discarded: `${clip.start.toFixed(1)}-${clip.end.toFixed(1)} (${clip.hook})`,
        kept: `${clash.start.toFixed(1)}-${clash.end.toFixed(1)} (${clash.hook})`,
      });
      continue;
    }
    kept.push(clip);
  }

  // Ordine cronologico: il resto della pipeline (e la dashboard) si aspetta le clip nell'ordine
  // in cui compaiono nel video, non in ordine di punteggio.
  return kept.sort((a, b) => a.start - b.start);
}

/** Quanto prima del gancio può iniziare il video reagito perché si parta da lì (oltre, il gancio arriverebbe troppo tardi). */
const MAX_REACTION_LEAD_SECONDS = 12;

/**
 * Reaction a un TikTok/video: lo Short parte dall'INIZIO del contenuto reagito, non a metà
 * (simo, 2026-09-26: "10.000 PERSONE... ERA UN'IA" partiva con "E c'era statizia", a metà del
 * video, e non si capiva di cosa parlassero). L'AI del ranking dice dove parte il contenuto
 * (reactedContentStart); qui lo si aggancia allo stacco di scena vero più vicino (il TikTok che
 * parte cambia di colpo mezzo schermo), altrimenti a quel secondo con mezzo secondo di respiro.
 * Solo se il contenuto parte al massimo MAX_REACTION_LEAD_SECONDS prima del gancio.
 */
export async function alignReactionStarts(
  clips: RankedClip[],
  segments: TranscriptSegment[],
  videoPath: string,
  videoId: string,
  detectCuts: (path: string, absStart: number, duration: number) => Promise<number[]>,
): Promise<RankedClip[]> {
  const out: RankedClip[] = [];
  for (const clip of clips) {
    const reacted = clip.reactedContentStart;
    if (reacted == null || reacted >= clip.start - 0.3 || clip.start - reacted > MAX_REACTION_LEAD_SECONDS) {
      out.push(clip);
      continue;
    }
    let start = Math.max(0, reacted - HOOK_LEAD_SECONDS);
    try {
      const windowStart = Math.max(0, reacted - 3);
      const cuts = (await detectCuts(videoPath, windowStart, 6)).map((t) => windowStart + t);
      const nearest = cuts.sort((a, b) => Math.abs(a - reacted) - Math.abs(b - reacted))[0];
      if (nearest !== undefined && Math.abs(nearest - reacted) <= 3) start = nearest + 0.05;
    } catch (err) {
      logger.warn("Stacchi di scena non letti, parto dal secondo indicato dall'AI", { videoId, error: err instanceof Error ? err.message : String(err) });
    }
    // Più lungo del tetto: si accorcia il finale sull'ultima frase che ci sta.
    let end = clip.end;
    if (end - start > CLIP_DURATION_TARGET.hardMax) {
      const limit = start + CLIP_DURATION_TARGET.hardMax;
      const lastFitting = segments.filter((s) => s.start >= start && s.end <= limit).pop();
      end = lastFitting ? lastFitting.end : limit;
    }
    logger.info("Reaction: lo Short parte dall'inizio del contenuto reagito", {
      videoId,
      hook: clip.hook,
      from: clip.start.toFixed(1),
      to: start.toFixed(1),
    });
    out.push({
      ...clip,
      start,
      end,
      duration: end - start,
      edl: { ...clip.edl, events: clip.edl.events.filter((event) => event.time >= start && event.time <= end) },
    });
  }
  return out;
}
