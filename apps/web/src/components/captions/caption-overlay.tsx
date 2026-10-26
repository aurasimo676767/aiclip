"use client";

import { useMemo, type CSSProperties } from "react";
import {
  CAPTION_FONTS,
  buildCaptionCues,
  cueLayout,
  headlineEnd,
  headlineText,
  type CaptionCue,
  type CaptionSettings,
  type CaptionTrack,
} from "@clipforge/shared";

/** Cerca la riga a schermo all'istante t (le righe sono ordinate e non si sovrappongono). */
function cueAt(cues: CaptionCue[], t: number): { cue: CaptionCue; index: number } | null {
  let lo = 0;
  let hi = cues.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const c = cues[mid]!;
    if (t < c.start) hi = mid - 1;
    else if (t >= c.end) lo = mid + 1;
    else return { cue: c, index: mid };
  }
  return null;
}

/** A video fermo fra due parole: la prossima riga (o l'ultima, a fine video), così mentre si cambia lo stile il testo si vede sempre. */
function nearestCue(cues: CaptionCue[], t: number): { cue: CaptionCue; index: number } | null {
  if (cues.length === 0) return null;
  const index = cues.findIndex((c) => c.start >= t);
  const i = index === -1 ? cues.length - 1 : index;
  return { cue: cues[i]!, index: i };
}

/** L'indice della prima riga del gruppo: cambia solo quando entra una riga nuova, così l'animazione d'entrata non riparte sui pezzi successivi. */
function entranceIndex(cues: CaptionCue[], index: number): number {
  let i = index;
  while (i > 0 && !cues[i]!.entrance) i--;
  return i;
}

/**
 * I sottotitoli disegnati sopra il video SENZA sottotitoli, nello stile scelto, all'istante `time`.
 * Le righe e i loro tempi vengono da buildCaptionCues (packages/shared), lo stesso calcolo che il
 * worker usa per bruciarli nel video: quello che si vede qui è quello che esce. Misure in pixel del
 * video (1080 di larghezza) riportate alla larghezza del riquadro. `hold` (video in pausa): fra due
 * parole resta a schermo la prossima invece del vuoto.
 */
export function CaptionOverlay({ track, settings, time, width, hold = false }: { track: CaptionTrack; settings: CaptionSettings; time: number; width: number; hold?: boolean }) {
  const cues = useMemo(() => buildCaptionCues(track, settings), [track, settings]);
  const k = width / 1080;
  const found = cueAt(cues, time) ?? (hold ? nearestCue(cues, time) : null);
  const title = headlineText(track, settings);
  const showTitle = title && time < headlineEnd(track.duration, settings);

  return (
    <div className="pointer-events-none absolute inset-0 overflow-hidden" aria-hidden>
      {showTitle && <HeadlinePreview text={title} settings={settings} k={k} />}
      {/* Cambiare l'entrata la rifà vedere subito; gli altri ritocchi (grandezza, colori) non la fanno ripartire a ogni scatto del cursore. */}
      {found && <CaptionLine key={`${entranceIndex(cues, found.index)}-${settings.animation}`} cue={found.cue} settings={settings} k={k} />}
      {settings.progressBar && track.duration > 0 && (
        <div className="absolute bottom-0 left-0 bg-white/85" style={{ height: Math.max(2, 14 * k), width: `${Math.min(100, (time / track.duration) * 100)}%` }} />
      )}
    </div>
  );
}

export function captionTextStyle(settings: CaptionSettings, k: number): CSSProperties {
  const font = CAPTION_FONTS[settings.font];
  const shadows: string[] = [];
  if (settings.glow > 0) {
    const g = settings.glow * 2.2 * k;
    // Tre ombre sovrapposte: con due il bagliore usciva più debole di quello bruciato da libass.
    shadows.push(`0 0 ${g * 0.6}px ${settings.strokeColor}`, `0 0 ${g}px ${settings.strokeColor}`, `0 0 ${g * 2}px ${settings.strokeColor}`);
  }
  if (settings.shadow > 0) {
    const d = settings.shadow * k;
    shadows.push(`${d}px ${d}px 0 rgba(0,0,0,0.5)`);
  }
  return {
    fontFamily: font.css,
    fontWeight: font.weight,
    fontSize: settings.size * font.cssScale * k,
    lineHeight: 1.05,
    color: settings.textColor,
    WebkitTextStroke: settings.strokeWidth > 0 ? `${settings.strokeWidth * 2 * k}px ${settings.strokeColor}` : undefined,
    paintOrder: "stroke fill",
    textShadow: shadows.length ? shadows.join(", ") : undefined,
    whiteSpace: "nowrap",
    textAlign: "center",
  };
}

function CaptionLine({ cue, settings, k }: { cue: CaptionCue; settings: CaptionSettings; k: number }) {
  const { lines, scaleX, scaleY } = cueLayout(cue.words, settings);
  const single = cue.words.length === 1;
  const loud = single ? cue.words[0]!.loud : 0;
  const key = single && cue.words[0]!.key;
  const rest = loud === 2 ? 1.15 : loud === 1 ? 1.06 : 1;
  const [from, peak, dip, tilt] =
    loud === 2 ? [0.3, 1.65, 1.08, 12] : loud === 1 ? [0.35, 1.45, 0.98, 10] : key ? [0.4, 1.32, 0.96, 8] : [0.45, 1.22, 0.96, 6];
  // ASS ruota in senso antiorario per angoli positivi, CSS in senso orario: verso invertito.
  const angle = (cue.group % 2 === 0 ? tilt : -tilt) * -1;
  const anim = settings.animation === "none" ? "" : `cap-anim-${settings.animation}`;
  const shake = loud === 2 && (settings.animation === "pop" || settings.animation === "bounce") ? "cap-shake" : "";

  return (
    <div className="absolute left-1/2" style={{ top: `${cue.y * 100}%`, transform: `translate(-50%, -50%) scale(${scaleX * rest}, ${scaleY * rest})` }}>
      <div
        className={`cap-line ${anim} ${shake}`}
        style={{ ...captionTextStyle(settings, k), "--from": from, "--peak": peak, "--dip": dip, "--tilt": `${angle}deg` } as CSSProperties}
      >
        {lines.map((line, li) => (
          <div key={li}>
            {line.map((i, n) => {
              const w = cue.words[i]!;
              const color = cue.activeIndex === i && settings.activeColor ? settings.activeColor : w.color;
              return (
                <span key={i} style={{ color }}>
                  {n > 0 ? " " : ""}
                  {w.text}
                </span>
              );
            })}
          </div>
        ))}
      </div>
    </div>
  );
}

/** Il titolo d'apertura come lo disegna il worker (headline.ts): Montserrat Black Italic, due righe al massimo. */
function HeadlinePreview({ text, settings, k }: { text: string; settings: CaptionSettings; k: number }) {
  const words = text.toUpperCase().split(/\s+/).filter(Boolean);
  const lines = words.join(" ").length <= 16 || words.length < 2 ? [words] : splitBalanced(words);
  const style = settings.headline.style;
  const size = 86 * k;
  return (
    <div className="absolute inset-x-0 animate-[cap-bounce_250ms_linear_both] text-center" style={{ top: 175 * k, transform: "translateY(-50%)" }}>
      {lines.map((line, i) => {
        const accent = !(lines.length > 1 && i === 0);
        const base: CSSProperties = { fontFamily: "'CF Montserrat Italic', 'CF Montserrat', Arial, sans-serif", fontWeight: 900, fontSize: size, lineHeight: 1.12, whiteSpace: "nowrap" };
        if (style === "riquadro") {
          return (
            <div key={i}>
              <span style={{ ...base, color: "#111", background: accent ? "#FFD400" : "#fff", borderRadius: size * 0.16, padding: `0 ${size * 0.28}px`, display: "inline-block" }}>{line.join(" ")}</span>
            </div>
          );
        }
        if (style === "neon") {
          return (
            <div key={i} style={{ ...base, color: "#fff", WebkitTextStroke: `${12 * 0.5 * k}px #00C8FF`, paintOrder: "stroke fill", textShadow: `0 0 ${18 * k}px #00C8FF, 0 0 ${36 * k}px #00C8FF` }}>
              {line.join(" ")}
            </div>
          );
        }
        const fill = style === "bianco" || !accent ? "#ffffff" : style === "verde" ? "#56f07a" : "#ffd21a";
        return (
          <div key={i} style={{ ...base, color: fill, WebkitTextStroke: `${12 * k}px #000`, paintOrder: "stroke fill", textShadow: `${5 * k}px ${7 * k}px 0 rgba(0,0,0,0.6)` }}>
            {line.join(" ")}
          </div>
        );
      })}
    </div>
  );
}

function splitBalanced(words: string[]): string[][] {
  const len = (ws: string[]) => ws.join(" ").length;
  let best = 1;
  let diff = Infinity;
  for (let i = 1; i < words.length; i++) {
    const d = Math.abs(len(words.slice(0, i)) - len(words.slice(i)));
    if (d < diff) {
      diff = d;
      best = i;
    }
  }
  return [words.slice(0, best), words.slice(best)];
}
