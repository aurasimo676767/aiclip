"use client";

import type { CaptionSettings, CaptionTrack } from "@clipforge/shared";
import { CaptionOverlay } from "@/components/captions/caption-overlay";

/** Riquadro 540x960 col fotogramma e i sottotitoli fermi all'istante t (senza animazione d'entrata). */
export function OverlayTest({ track, settings, t }: { track: CaptionTrack; settings: CaptionSettings; t: number }) {
  return (
    <div style={{ position: "relative", width: 540, height: 960, background: "#000" }}>
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img src={`/dev-preview/frame-${t}.jpg`} alt="" style={{ width: "100%", height: "100%", objectFit: "cover" }} />
      <CaptionOverlay track={track} settings={{ ...settings, animation: "none" }} time={t} width={540} />
    </div>
  );
}
