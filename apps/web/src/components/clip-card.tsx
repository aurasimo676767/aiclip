"use client";

import { useRef, useState } from "react";
import { Check, Loader2, AlertTriangle, MonitorPlay as YoutubeIcon } from "lucide-react";
import { overallScore } from "@clipforge/shared";
import type { ClipViewModel } from "./clip-list";
import { StatusBadge } from "./status-badge";
import { ScoreRing, formatDuration } from "./ui";

interface ClipCardProps {
  clip: ClipViewModel;
  rank: number;
  selectable: boolean;
  selected: boolean;
  selectionActive: boolean;
  onToggle: () => void;
  onOpen: () => void;
}

/**
 * Card di una clip nella griglia: copertina verticale (Shorts) o orizzontale (long-form), punteggio,
 * durata e stato sopra l'immagine; il video parte muto al passaggio del mouse.
 */
export function ClipCard({ clip, rank, selectable, selected, selectionActive, onToggle, onOpen }: ClipCardProps) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const [hovering, setHovering] = useState(false);
  const score = overallScore(clip.scores);
  const isShort = clip.format === "short";
  const working = clip.status === "QUEUED" || clip.status === "RENDERING";

  return (
    <div
      className={`group relative flex flex-col gap-2 animate-fade-in ${isShort ? "" : "col-span-2"}`}
      onMouseEnter={() => setHovering(true)}
      onMouseLeave={() => setHovering(false)}
    >
      <button
        onClick={onOpen}
        className={`relative w-full overflow-hidden rounded-xl border bg-raised text-left transition focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-400 ${
          isShort ? "aspect-[9/16]" : "aspect-video"
        } ${selected ? "border-brand-400 ring-2 ring-brand-400/50" : "border-line group-hover:border-line-strong"}`}
      >
        {clip.thumbnailUrl ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={clip.thumbnailUrl} alt="" loading="lazy" className="absolute inset-0 h-full w-full object-cover" />
        ) : (
          <div className="absolute inset-0 flex items-center bg-[radial-gradient(circle_at_20%_10%,rgba(124,92,255,0.35),transparent_55%),radial-gradient(circle_at_90%_90%,rgba(255,92,168,0.22),transparent_50%)] px-3 pb-8 pt-12">
            <p className="line-clamp-5 font-display text-sm font-semibold leading-snug text-white/85">&ldquo;{clip.hook}&rdquo;</p>
          </div>
        )}

        {/* Anteprima video solo al passaggio del mouse: caricarle tutte insieme peserebbe troppo. */}
        {hovering && clip.videoUrl && (
          <video
            ref={videoRef}
            src={clip.videoUrl}
            poster={clip.thumbnailUrl ?? undefined}
            muted
            autoPlay
            loop
            playsInline
            className="absolute inset-0 h-full w-full object-cover"
          />
        )}

        <div className="pointer-events-none absolute inset-0 bg-gradient-to-b from-black/50 via-transparent to-black/70" />

        <div className="absolute right-2 top-2">
          <ScoreRing score={score} size={isShort ? 38 : 42} />
        </div>
        <span className="absolute left-2 top-2 rounded-md bg-black/60 px-1.5 py-0.5 font-display text-xs font-bold text-white/90 backdrop-blur">#{rank}</span>

        <div className="absolute inset-x-2 bottom-2 flex items-center justify-between gap-2">
          {working ? (
            <span className="inline-flex items-center gap-1 rounded-md bg-black/70 px-1.5 py-0.5 text-[11px] font-medium text-amber-200 backdrop-blur">
              <Loader2 size={11} className="animate-spin" /> {clip.status === "QUEUED" ? "In coda" : "Rendering"}
            </span>
          ) : clip.status === "FAILED" ? (
            <span className="inline-flex items-center gap-1 rounded-md bg-red-500/80 px-1.5 py-0.5 text-[11px] font-medium text-white">
              <AlertTriangle size={11} /> Errore
            </span>
          ) : clip.youtubeUrl ? (
            <span className="inline-flex items-center gap-1 rounded-md bg-red-600/90 px-1.5 py-0.5 text-[11px] font-medium text-white">
              <YoutubeIcon size={11} /> {clip.youtubePublishAt && new Date(clip.youtubePublishAt).getTime() > Date.now() ? "Programmato" : "Online"}
            </span>
          ) : clip.status !== "COMPLETED" ? (
            <StatusBadge status={clip.status} className="bg-black/60 backdrop-blur" />
          ) : (
            <span />
          )}
          <span className="rounded-md bg-black/70 px-1.5 py-0.5 text-[11px] font-medium tabular-nums text-white backdrop-blur">{formatDuration(clip.duration)}</span>
        </div>
      </button>

      {selectable && (
        <button
          onClick={onToggle}
          aria-label={selected ? "Deseleziona" : "Seleziona"}
          className={`absolute left-2 top-9 flex h-6 w-6 items-center justify-center rounded-md border transition ${
            selected
              ? "border-brand-400 bg-brand-500 text-white"
              : `border-white/40 bg-black/50 text-transparent backdrop-blur hover:border-white ${selectionActive ? "opacity-100" : "opacity-0 group-hover:opacity-100"}`
          }`}
        >
          <Check size={14} strokeWidth={3} />
        </button>
      )}

      <button onClick={onOpen} className="text-left">
        <h3 className="line-clamp-2 text-sm font-medium leading-snug text-ink transition group-hover:text-white">{clip.title}</h3>
      </button>
    </div>
  );
}
