import type { EDLEvent } from "@clipforge/shared";

const RAMP_SECONDS = 0.25;
const HOLD_SECONDS = 1.1;
const MAX_SCALE = 2.2;

interface ZoomPulse {
  time: number;
  scale: number;
}

/**
 * Estrae gli eventi "zoom"/"punch_in" dall'EDL (già rimappati in tempo clip-relativo) e
 * costruisce un'espressione ffmpeg valida per il filtro `crop`, che simula un piccolo
 * "pulse" di zoom-in/out attorno a ogni evento (rampa lineare su + hold + rampa lineare giù).
 * Più eventi sovrapposti: si prende il massimo zoom attivo in ogni istante.
 *
 * Ritorna l'espressione da usare come divisore di iw/ih nel filtro crop (1.0 = nessuno zoom).
 */
export function buildZoomExpression(events: EDLEvent[], zoomIntensity: number): string {
  const pulses: ZoomPulse[] = events
    .filter((e): e is Extract<EDLEvent, { action: "zoom" | "punch_in" }> => e.action === "zoom" || e.action === "punch_in")
    .map((e) => ({
      time: Math.max(0, e.time),
      scale: clampScale(1 + (e.scale - 1) * zoomIntensity),
    }));

  if (pulses.length === 0) {
    return "1";
  }

  let expr = "1";
  for (const pulse of pulses) {
    expr = pulseExpr(pulse, expr);
  }
  return expr;
}

function clampScale(scale: number): number {
  return Math.min(Math.max(scale, 1), MAX_SCALE);
}

/** Combina un nuovo pulse con l'espressione esistente prendendo il massimo dei due in ogni istante. */
function pulseExpr(pulse: ZoomPulse, fallbackExpr: string): string {
  const upStart = pulse.time;
  const upEnd = pulse.time + RAMP_SECONDS;
  const holdEnd = upEnd + HOLD_SECONDS;
  const downEnd = holdEnd + RAMP_SECONDS;

  const rampUp = `(1+(${pulse.scale}-1)*(t-${upStart})/${RAMP_SECONDS})`;
  const rampDown = `(${pulse.scale}-(${pulse.scale}-1)*(t-${holdEnd})/${RAMP_SECONDS})`;

  const thisPulse = `if(lt(t,${upStart}),1,if(lt(t,${upEnd}),${rampUp},if(lt(t,${holdEnd}),${pulse.scale},if(lt(t,${downEnd}),${rampDown},1))))`;

  return `max(${thisPulse},${fallbackExpr})`;
}
