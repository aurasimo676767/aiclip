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
  const start = startSegment ? startSegment.start : nextSegment ? nextSegment.start : clip.start;

  const inside = segments.filter((s) => s.start >= start && s.start < clip.end);
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
