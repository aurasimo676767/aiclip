"use client";

import { useMemo, useRef } from "react";
import { useReducedMotion } from "./use-reduced-motion";
import type { CaptionSettings, CaptionTrack } from "@clipforge/shared";
import { CaptionOverlay } from "./caption-overlay";
import { useElementWidth, useLoopClock } from "./use-captions-runtime";

/** Frase d'esempio per le anteprime dei preset: una parola chiave e un urlo, per far vedere tutti i colori. */
const DEMO_WORDS: Array<[string, number, number, 0 | 1 | 2, boolean]> = [
  ["Non", 0.1, 0.42, 0, false],
  ["ci", 0.42, 0.62, 0, false],
  ["credo", 0.62, 1.1, 0, true],
  ["bro", 1.1, 1.45, 0, false],
  ["guarda", 1.6, 2.0, 0, false],
  ["qua!", 2.0, 2.6, 2, false],
];
const DEMO_PERIOD = 3.1;
const DEMO_ZOOM = 1.4;

export function demoTrack(): CaptionTrack {
  return {
    version: 1,
    duration: DEMO_PERIOD,
    words: DEMO_WORDS.map(([text, start, end, loud, key]) => ({ text, start, end, loud, key })),
    anchors: [{ start: 0, end: DEMO_PERIOD, y: 0.5 }],
    headline: null,
  };
}

/**
 * Esempio animato di uno stile: la frase d'esempio scorre in loop sopra un fotogramma, con le stesse
 * entrate e gli stessi colori del video vero. Si ferma quando esce dallo schermo; con "riduci
 * animazioni" mostra una sola parola ferma.
 */
export function PresetDemo({ settings, background }: { settings: CaptionSettings; background?: string | null }) {
  const [ref, width] = useElementWidth<HTMLDivElement>();
  const boxRef = useRef<HTMLDivElement>(null);
  const reduced = useReducedMotion();
  const t = useLoopClock(DEMO_PERIOD, boxRef, !reduced);
  const track = useMemo(demoTrack, []);
  // Nelle schede piccole la posizione segue lo stile, ma "auto" sta al centro della scheda.
  const shown = useMemo(() => ({ ...settings, headline: { ...settings.headline, enabled: false }, progressBar: false }), [settings]);
  return (
    <div ref={boxRef} className="absolute inset-0">
      <div ref={ref} className="absolute inset-0 overflow-hidden">
        {background ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={background} alt="" className="h-full w-full object-cover opacity-80" />
        ) : (
          <div className="h-full w-full bg-[radial-gradient(120%_80%_at_30%_20%,#2a3550_0%,#14161d_55%,#0d0e12_100%)]" />
        )}
        {/* Nelle schede piccole le scritte si ingrandiscono del 40%: alla misura vera sarebbero illeggibili. */}
        {width > 0 && <CaptionOverlay track={track} settings={shown} time={reduced ? 0.8 : t} width={width * DEMO_ZOOM} />}
      </div>
    </div>
  );
}
