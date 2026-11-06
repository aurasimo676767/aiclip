import fsp from "node:fs/promises";
import path from "node:path";
import { env } from "../env.js";
import { runFfmpeg } from "../lib/ffmpeg.js";
import { logger } from "../lib/logger.js";

/**
 * Transizione veloce fra la frase d'apertura dello streamer e l'inizio del gioco (simo, 2026-11-06:
 * "una transizione VELOCE tipo interferenza, ma non quella colorata"; dopo le prime prove: "non voglio
 * lampi, voglio che si distorce tutto velocemente e cambi al gioco... non bianco e nero ma tipo bianco
 * e grigio"). La coda della frase si deforma sempre di più mentre il colore sparisce verso un
 * bianco-grigio lattiginoso; il gioco esce dalla stessa deformazione che si ricompone. Niente lampi né
 * sorgenti a parte: solo filtri sui fotogrammi, così resta la frequenza dei fotogrammi del video.
 */

export type TransitionStyle = "strappo" | "onda";

/** "strappo" consigliato e scelto il 2026-11-06 (fasce che scivolano di lato); "onda" resta provabile. */
export const TRANSITION_STYLE: TransitionStyle = "strappo";

/** Coda della frase che si deforma e testa del gioco che si ricompone (secondi). */
export const TAIL_SECONDS = 0.24;
export const HEAD_SECONDS = 0.24;

/**
 * Deformazione con forza `k` (espressione di T, 0 = ferma, 1 = massima) e colore rimasto `c`.
 * Gli spostamenti sono in pixel del fotogramma intero: SW/SH li scalano sui piani del colore, che sono
 * a metà risoluzione (senza, il colore restava fermo e faceva frange arcobaleno).
 */
function warp(style: TransitionStyle, k: string, c: string): string {
  const dx =
    style === "onda"
      ? `140*pow(${k}\\,2)*sin((Y/SH)/23+T*60)`
      : `220*pow(${k}\\,1.5)*sin(floor((Y/SH)/48)*12.9)*sin(T*25+floor((Y/SH)/48))`;
  const dy = style === "onda" ? `50*pow(${k}\\,2)*sin((X/SW)/41+T*45)` : "0";
  const chroma = (p: "cb" | "cr") => `128+(${p}(X+SW*${dx}\\,Y+SH*${dy})-128)*(${c})`;
  return `geq=lum='lum(X+${dx}\\,Y+${dy})':cb='${chroma("cb")}':cr='${chroma("cr")}'`;
}

/** Filtri della coda (tempi da 0 a TAIL_SECONDS) e della testa (da 0 a HEAD_SECONDS) per lo stile. */
export function transitionFilters(style: TransitionStyle = TRANSITION_STYLE): { tail: string; head: string } {
  const kTail = `(T/${TAIL_SECONDS})`;
  const kHead = `(T/${HEAD_SECONDS})`;
  // Toni bianco-grigio: meno contrasto e più luce mentre si deforma, poi si torna normali.
  const washIn = `eq=contrast='1-0.45*(t/${TAIL_SECONDS})':brightness='0.18*(t/${TAIL_SECONDS})':eval=frame`;
  const washOut = `eq=contrast='0.55+0.45*(t/${HEAD_SECONDS})':brightness='0.18*(1-t/${HEAD_SECONDS})':eval=frame`;
  return {
    tail: `format=yuv420p,${warp(style, kTail, `1-${kTail}`)},${washIn}`,
    head: `format=yuv420p,${warp(style, `(1-${kHead})`, kHead)},${washOut}`,
  };
}

/** Il fruscio morbido della transizione (~0,5 s), creato una volta e tenuto su disco. */
export async function ensureTransitionSfx(): Promise<string | null> {
  const out = path.join(env.WORKER_TMP_DIR, "branding", "transition-sfx-v2.wav");
  if (await fsp.access(out).then(() => true).catch(() => false)) return out;
  try {
    await fsp.mkdir(path.dirname(out), { recursive: true });
    await runFfmpeg([
      "-y",
      "-f",
      "lavfi",
      "-i",
      "anoisesrc=d=0.5:c=pink:a=0.35:r=44100,highpass=f=300,lowpass=f=6000,afade=t=in:d=0.12,afade=t=out:st=0.28:d=0.22,volume=0.8",
      "-ac",
      "2",
      out,
    ]);
    return out;
  } catch (error) {
    logger.warn("Suono della transizione non creato: transizione muta", { error: error instanceof Error ? error.message : String(error) });
    return null;
  }
}
