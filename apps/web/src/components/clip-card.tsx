"use client";

import { useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Check, Loader2, AlertTriangle, MonitorPlay as YoutubeIcon } from "lucide-react";
import { feedRisk, overallScore } from "@clipforge/shared";
import type { ClipViewModel } from "./clip-list";
import { StatusBadge } from "./status-badge";
import { ScoreRing, formatDuration } from "./ui";
import { GamePicker } from "./game-picker";

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
          <div className="absolute inset-0 flex items-center bg-overlay px-3 pb-8 pt-12">
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
              ? "border-brand-400 bg-brand-400 text-on-brand animate-pop-check"
              : `border-white/40 bg-black/50 text-transparent backdrop-blur hover:border-white ${selectionActive ? "opacity-100" : "opacity-0 group-hover:opacity-100"}`
          }`}
        >
          <Check size={14} strokeWidth={3} />
        </button>
      )}

      <button onClick={onOpen} className="text-left">
        <h3 className="line-clamp-2 text-sm font-medium leading-snug text-ink transition group-hover:text-white">{clip.title}</h3>
      </button>
      {isShort && <PublishChips clip={clip} />}
      {!isShort && <EditToggle clipId={clip.id} enabled={clip.longformEdit} />}
      {!isShort && clip.longformEdit && <GamePicker clipId={clip.id} games={clip.longformGames} keep={clip.longformKeepGames} compact />}
    </div>
  );
}

/**
 * Interruttore "Montato" direttamente nella lista (simo, 2026-09-28): si decide clip per clip, prima
 * di generarle, se montarla come uno YouTuber (parti morte tolte, intro "IN QUESTO VIDEO") o solo
 * tagliarla. Stessa API dell'interruttore nel dettaglio della clip.
 */
function EditToggle({ clipId, enabled }: { clipId: string; enabled: boolean }) {
  const router = useRouter();
  const [on, setOn] = useState(enabled);
  const [busy, setBusy] = useState(false);
  async function toggle() {
    const next = !on;
    setOn(next);
    setBusy(true);
    try {
      const res = await fetch(`/api/clips/${clipId}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ longformEdit: next }),
      });
      if (!res.ok) setOn(!next);
      else router.refresh();
    } catch {
      setOn(!next);
    } finally {
      setBusy(false);
    }
  }
  return (
    <label className="inline-flex w-fit cursor-pointer items-center gap-2 text-xs text-muted">
      <button
        type="button"
        role="switch"
        aria-checked={on}
        aria-label="Montato"
        disabled={busy}
        onClick={toggle}
        className={`relative h-5 w-9 shrink-0 rounded-full border transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-400/70 disabled:opacity-60 ${
          on ? "border-brand-400 bg-brand-400" : "border-line-strong bg-canvas"
        }`}
      >
        <span className={`absolute top-0.5 h-3.5 w-3.5 rounded-full transition-all ${on ? "left-[18px] bg-on-brand" : "left-0.5 bg-faint"}`} />
      </button>
      <span className={on ? "font-medium text-ink" : ""}>Montato</span>
    </label>
  );
}

/** Stato TikTok e avviso sul titolo a rischio, sotto il titolo della scheda. */
function PublishChips({ clip }: { clip: ClipViewModel }) {
  const risky = !clip.youtubeUrl && feedRisk(`${clip.title}
${clip.publishDescription}`).length > 0;
  const tiktok =
    clip.tiktokStatus === "COMPLETED"
      ? { label: "TikTok ok", cls: "bg-raised text-ink" }
      : clip.tiktokStatus === "FAILED"
        ? { label: "TikTok non uscito", cls: "bg-red-500/15 text-red-300" }
        : clip.tiktokStatus
          ? { label: "TikTok in corso", cls: "bg-amber-500/15 text-amber-200" }
          : null;
  if (!risky && !tiktok) return null;
  return (
    <div className="flex flex-wrap gap-1.5 text-[11px] font-medium">
      {tiktok && <span className={`rounded-md px-1.5 py-0.5 ${tiktok.cls}`}>{tiktok.label}</span>}
      {risky && (
        <span className="inline-flex items-center gap-1 rounded-md bg-amber-500/15 px-1.5 py-0.5 text-amber-200" title="Parole che YouTube non fa girare: apri la clip per vederle">
          <AlertTriangle size={11} /> Titolo a rischio
        </span>
      )}
    </div>
  );
}
