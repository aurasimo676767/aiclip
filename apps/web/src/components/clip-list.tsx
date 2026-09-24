"use client";

import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { CalendarClock, Loader2, Sparkles, X } from "lucide-react";
import { overallScore, type ClipScores, type ClipBadge } from "@clipforge/shared";
import { ClipCard } from "./clip-card";
import { ClipDetailDialog } from "./clip-detail-dialog";
import { Alert, EmptyState } from "./ui";

export interface ClipViewModel {
  id: string;
  title: string;
  hook: string;
  reason: string;
  duration: number;
  scores: ClipScores;
  status: string;
  errorMessage: string | null;
  hashtags: string[];
  caption: string;
  /** Descrizione precompilata nel form di pubblicazione: per il long-form è un preset fisso di crediti allo streamer (non il riassunto IA di `caption`). */
  publishDescription: string;
  youtubePublishStatus: string | null;
  youtubeUrl: string | null;
  youtubeError: string | null;
  youtubePublishAt: string | null;
  youtubeCancelledAt: string | null;
  badges: ClipBadge[];
  format: "short" | "longform";
  /** URL firmati (validi qualche ora), null finché la clip non è renderizzata. */
  thumbnailUrl: string | null;
  videoUrl: string | null;
}

type Filter = "all" | "todo" | "working" | "ready" | "published";

const FILTERS: Array<{ id: Filter; label: string; match: (c: ClipViewModel) => boolean }> = [
  { id: "all", label: "Tutte", match: () => true },
  { id: "todo", label: "Da generare", match: (c) => c.status === "SUGGESTED" || c.status === "FAILED" },
  { id: "working", label: "In render", match: (c) => c.status === "QUEUED" || c.status === "RENDERING" },
  { id: "ready", label: "Pronte", match: (c) => c.status === "COMPLETED" && !c.youtubeUrl },
  { id: "published", label: "Su YouTube", match: (c) => Boolean(c.youtubeUrl) },
];

export function isRenderable(clip: ClipViewModel): boolean {
  return clip.status === "SUGGESTED" || clip.status === "FAILED";
}

/** Un job annullato non blocca una nuova programmazione: il video è stato eliminato da YouTube. */
export function isSchedulable(clip: ClipViewModel, youtubeConnected: boolean): boolean {
  return youtubeConnected && clip.status === "COMPLETED" && (clip.youtubePublishStatus === null || clip.youtubeCancelledAt !== null);
}

export function ClipList({ clips, youtubeConnected, compact = false }: { clips: ClipViewModel[]; youtubeConnected: boolean; compact?: boolean }) {
  const router = useRouter();
  const [filter, setFilter] = useState<Filter>("all");
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [openClipId, setOpenClipId] = useState<string | null>(null);
  const [busy, setBusy] = useState<"render" | "schedule" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  const sorted = useMemo(() => [...clips].sort((a, b) => overallScore(b.scores) - overallScore(a.scores)), [clips]);
  const visible = sorted.filter(FILTERS.find((f) => f.id === filter)!.match);
  const openClip = clips.find((c) => c.id === openClipId) ?? null;

  const selectedClips = clips.filter((c) => selected.has(c.id));
  const toRender = selectedClips.filter(isRenderable);
  const toSchedule = selectedClips.filter((c) => isSchedulable(c, youtubeConnected));

  function toggle(id: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function selectAllRenderable() {
    setSelected(new Set(sorted.filter(isRenderable).map((c) => c.id)));
  }

  async function handleRender() {
    if (toRender.length === 0) return;
    setBusy("render");
    setError(null);
    setMessage(null);
    try {
      const res = await fetch("/api/clips/render", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ clipIds: toRender.map((c) => c.id) }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "Richiesta fallita");
      setMessage(`${toRender.length} ${toRender.length === 1 ? "clip messa" : "clip messe"} in render.`);
      setSelected(new Set());
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Errore imprevisto");
    } finally {
      setBusy(null);
    }
  }

  async function handleSchedule() {
    if (toSchedule.length === 0) return;
    setBusy("schedule");
    setError(null);
    setMessage(null);
    try {
      const res = await fetch("/api/clips/schedule-batch", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ clipIds: toSchedule.map((c) => c.id) }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "Programmazione fallita");
      const scheduled = data.scheduled as Array<{ clipId: string; publishAt: string }>;
      const errors = data.errors as Array<{ clipId: string; error: string }>;
      if (scheduled.length > 0) {
        const last = scheduled[scheduled.length - 1]!;
        setMessage(
          `${scheduled.length} clip programmate, l'ultima per il ${new Date(last.publishAt).toLocaleString("it-IT", { dateStyle: "medium", timeStyle: "short" })}` +
            (errors.length > 0 ? ` (${errors.length} saltate: ${errors[0]!.error})` : "."),
        );
      } else if (errors.length > 0) {
        setError(errors[0]!.error);
      }
      setSelected(new Set());
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Errore imprevisto");
    } finally {
      setBusy(null);
    }
  }

  const renderableCount = sorted.filter(isRenderable).length;

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-wrap gap-1.5">
          {FILTERS.map((f) => {
            const count = sorted.filter(f.match).length;
            if (f.id !== "all" && count === 0) return null;
            return (
              <button
                key={f.id}
                onClick={() => setFilter(f.id)}
                className={`rounded-full border px-3 py-1 text-xs font-medium transition ${
                  filter === f.id ? "border-brand-400/60 bg-brand-500/15 text-brand-100" : "border-line bg-raised text-muted hover:text-ink"
                }`}
              >
                {f.label} <span className="ml-0.5 text-faint">{count}</span>
              </button>
            );
          })}
        </div>
        {renderableCount > 0 && selected.size === 0 && (
          <button onClick={selectAllRenderable} className="btn btn-ghost btn-sm">
            Seleziona tutte da generare
          </button>
        )}
      </div>

      {error && <Alert>{error}</Alert>}
      {message && <Alert tone="success">{message}</Alert>}

      {visible.length === 0 ? (
        <EmptyState title="Nessuna clip in questa vista" description="Cambia filtro per vedere le altre." />
      ) : (
        <div className={`grid gap-4 ${compact ? "grid-cols-2" : "grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5"}`}>
          {visible.map((clip) => (
            <ClipCard
              key={clip.id}
              clip={clip}
              rank={sorted.indexOf(clip) + 1}
              selectable={isRenderable(clip) || isSchedulable(clip, youtubeConnected)}
              selected={selected.has(clip.id)}
              selectionActive={selected.size > 0}
              onToggle={() => toggle(clip.id)}
              onOpen={() => setOpenClipId(clip.id)}
            />
          ))}
        </div>
      )}

      {/* Barra azioni della selezione, fissa in basso */}
      {selected.size > 0 && (
        <div className="sticky bottom-4 z-30 mx-auto flex w-fit max-w-full flex-wrap items-center gap-2 rounded-2xl border border-line-strong bg-raised/95 p-2 pl-4 shadow-2xl backdrop-blur animate-fade-in">
          <span className="text-sm text-muted">
            <span className="font-semibold text-ink">{selected.size}</span> selezionate
          </span>
          {toRender.length > 0 && (
            <button onClick={handleRender} disabled={busy !== null} className="btn btn-gradient btn-sm">
              {busy === "render" ? <Loader2 size={14} className="animate-spin" /> : <Sparkles size={14} />}
              Genera {toRender.length}
            </button>
          )}
          {toSchedule.length > 0 && (
            <button onClick={handleSchedule} disabled={busy !== null} className="btn btn-primary btn-sm" title="Programma la pubblicazione automatica negli slot liberi">
              {busy === "schedule" ? <Loader2 size={14} className="animate-spin" /> : <CalendarClock size={14} />}
              Programma {toSchedule.length}
            </button>
          )}
          <button onClick={() => setSelected(new Set())} className="btn btn-ghost btn-sm" aria-label="Deseleziona tutto">
            <X size={14} />
          </button>
        </div>
      )}

      <ClipDetailDialog clip={openClip} youtubeConnected={youtubeConnected} onClose={() => setOpenClipId(null)} />
    </div>
  );
}
