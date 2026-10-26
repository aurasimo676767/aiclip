import fs from "node:fs";
import path from "node:path";
import { notFound } from "next/navigation";
import { BUILTIN_CAPTION_PRESETS, type CaptionTrack } from "@clipforge/shared";
import { OverlayTest } from "./overlay-test";

/**
 * Solo sviluppo: il fotogramma esatto dell'anteprima a t con sopra i sottotitoli disegnati dal sito,
 * per confrontarli al pixel col video renderizzato. ?t=13.2&preset=verde
 */
export default function OverlayPage({ searchParams }: { searchParams: { t?: string; preset?: string } }) {
  if (process.env.NODE_ENV === "production") notFound();
  const track = JSON.parse(fs.readFileSync(path.join(process.cwd(), "public", "dev-preview", "captions.json"), "utf8")) as CaptionTrack;
  const preset = BUILTIN_CAPTION_PRESETS.find((p) => p.id === searchParams.preset) ?? BUILTIN_CAPTION_PRESETS[0]!;
  return <OverlayTest track={track} settings={preset.settings} t={Number(searchParams.t ?? 0)} />;
}
