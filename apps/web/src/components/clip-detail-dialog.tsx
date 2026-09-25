"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Download, Loader2, MoreHorizontal, Pencil, RefreshCw, RotateCcw, Scissors, Send, Sparkles, X, Wand2 } from "lucide-react";
import { overallScore, type ClipBadge, type ClipScores } from "@clipforge/shared";
import type { ClipViewModel } from "./clip-list";
import { isRenderable } from "./clip-list";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "./ui-kit/dialog";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "./ui-kit/menu";
import { useConfirm } from "./ui-kit/confirm";
import { StatusBadge } from "./status-badge";
import { TrimPanel } from "./trim-clip-button";
import { PublishPanel, PublishStatus } from "./publish-youtube-button";
import { ScoreRing, formatDuration, scoreTone } from "./ui";

const BADGE_LABELS: Record<ClipBadge, string> = {
  gotcha: "🎯 Gotcha",
  cliffhanger: "⏳ Cliffhanger",
  controversial: "🔥 Controverso",
  relatable: "🙃 Relatable",
  high_energy: "⚡ Energia alta",
};

type Panel = "info" | "edit" | "trim" | "publish";

export function ClipDetailDialog({ clip, youtubeConnected, onClose }: { clip: ClipViewModel | null; youtubeConnected: boolean; onClose: () => void }) {
  return (
    <Dialog open={clip !== null} onOpenChange={(open) => !open && onClose()}>
      {clip && (
        <DialogContent
          hideClose
          className={`p-0 ${clip.format === "short" ? "max-w-5xl" : "max-w-6xl"}`}
          onOpenAutoFocus={(e) => e.preventDefault()}
        >
          <ClipDetail key={clip.id} clip={clip} youtubeConnected={youtubeConnected} onClose={onClose} />
        </DialogContent>
      )}
    </Dialog>
  );
}

function ClipDetail({ clip, youtubeConnected, onClose }: { clip: ClipViewModel; youtubeConnected: boolean; onClose: () => void }) {
  const router = useRouter();
  const confirm = useConfirm();
  const videoRef = useRef<HTMLVideoElement>(null);
  const [panel, setPanel] = useState<Panel>("info");
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const score = overallScore(clip.scores);
  const isShort = clip.format === "short";
  const working = clip.status === "QUEUED" || clip.status === "RENDERING";
  const canPublish = youtubeConnected && clip.status === "COMPLETED" && (clip.youtubePublishStatus === null || clip.youtubeCancelledAt !== null || clip.youtubePublishStatus === "FAILED");

  // Il pannello di pubblicazione non ha senso se nel frattempo la clip è stata pubblicata.
  useEffect(() => {
    if (panel === "publish" && !canPublish) setPanel("info");
  }, [panel, canPublish]);

  async function call(label: string, url: string, init?: RequestInit, success?: string) {
    setBusy(label);
    setError(null);
    setNotice(null);
    try {
      const res = await fetch(url, init);
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "Operazione fallita");
      if (success) setNotice(success);
      router.refresh();
      return data;
    } catch (err) {
      setError(err instanceof Error ? err.message : "Errore imprevisto");
      return null;
    } finally {
      setBusy(null);
    }
  }

  const render = () =>
    call("render", "/api/clips/render", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ clipIds: [clip.id] }) }, "Messa in coda per il render.");

  async function cancelRender() {
    const ok = await confirm({ title: "Annullare il render?", description: "La clip torna tra quelle suggerite.", confirmLabel: "Annulla render", destructive: true });
    if (ok) await call("cancel", `/api/clips/${clip.id}/cancel-render`, { method: "POST" });
  }

  return (
    <div className="flex flex-col md:flex-row">
      {/* Colonna player */}
      <div className={`flex shrink-0 items-center justify-center bg-black md:rounded-l-2xl ${isShort ? "p-3" : "md:w-[58%]"}`}>
        {/* Player grande: il video è 1080x1920, mostrato largo 300px sembrava a bassa risoluzione. */}
        <div className={`relative overflow-hidden rounded-xl ${isShort ? "aspect-[9/16] w-full max-w-[400px] md:h-[min(82vh,760px)] md:w-auto md:max-w-none" : "aspect-video w-full"}`}>
          {clip.videoUrl ? (
            <video ref={videoRef} src={clip.videoUrl} poster={clip.thumbnailUrl ?? undefined} controls playsInline preload="auto" className="h-full w-full bg-black object-contain" />
          ) : (
            <div className="flex h-full w-full flex-col items-center justify-center gap-3 bg-[radial-gradient(circle_at_30%_20%,rgba(124,92,255,0.3),transparent_60%)] p-6 text-center">
              {working ? (
                <>
                  <Loader2 size={28} className="animate-spin text-brand-300" />
                  <p className="text-sm text-muted">{clip.status === "QUEUED" ? "In coda per il render…" : "Rendering in corso…"}</p>
                </>
              ) : (
                <>
                  <p className="font-display text-base font-semibold leading-snug text-white/90">&ldquo;{clip.hook}&rdquo;</p>
                  <p className="text-xs text-faint">Il video non è ancora stato generato.</p>
                </>
              )}
            </div>
          )}
        </div>
      </div>

      {/* Colonna dettagli */}
      <div className="flex min-w-0 flex-1 flex-col gap-5 p-5 sm:p-6">
        <div className="flex items-start gap-3">
          <ScoreRing score={score} size={52} />
          <div className="min-w-0 flex-1">
            <DialogTitle className="text-base sm:text-lg">{clip.title}</DialogTitle>
            <DialogDescription asChild>
              <div className="mt-1.5 flex flex-wrap items-center gap-2 text-xs text-muted">
                <StatusBadge status={clip.status} />
                <span className="tabular-nums">{formatDuration(clip.duration)}</span>
                <span>·</span>
                <span>{isShort ? "Short verticale" : "Video long-form"}</span>
              </div>
            </DialogDescription>
          </div>
          <button onClick={onClose} className="rounded-md p-1 text-faint transition hover:bg-raised hover:text-ink" aria-label="Chiudi">
            <X size={18} />
          </button>
        </div>

        {/* Azioni principali */}
        <div className="flex flex-wrap items-center gap-2">
          {isRenderable(clip) && (
            <button onClick={render} disabled={busy !== null} className="btn btn-gradient btn-sm">
              {busy === "render" ? <Loader2 size={14} className="animate-spin" /> : clip.status === "FAILED" ? <RotateCcw size={14} /> : <Sparkles size={14} />}
              {clip.status === "FAILED" ? "Riprova render" : "Genera video"}
            </button>
          )}
          {clip.videoUrl && (
            <a href={clip.videoUrl} download className="btn btn-secondary btn-sm">
              <Download size={14} /> Scarica
            </a>
          )}
          {isShort && clip.status === "COMPLETED" && (
            <button
              onClick={() => call("regenerate", `/api/clips/${clip.id}/regenerate`, { method: "POST" }, "Clip in coda: il video si sta rigenerando.")}
              disabled={busy !== null}
              className="btn btn-secondary btn-sm"
              title="Rifà il video di questa clip con l'impaginazione e i sottotitoli attuali (non usa l'AI)"
            >
              {busy === "regenerate" ? <Loader2 size={14} className="animate-spin" /> : <RefreshCw size={14} />}
              Rigenera clip
            </button>
          )}
          {canPublish && (
            <button onClick={() => setPanel("publish")} className="btn btn-primary btn-sm">
              <Send size={14} /> Pubblica
            </button>
          )}
          {working && (
            <button onClick={cancelRender} disabled={busy !== null} className="btn btn-secondary btn-sm">
              <X size={14} /> Annulla render
            </button>
          )}
          <DropdownMenu>
            <DropdownMenuTrigger className="btn btn-ghost btn-sm" aria-label="Altre azioni">
              <MoreHorizontal size={16} />
            </DropdownMenuTrigger>
            <DropdownMenuContent>
              <DropdownMenuItem onSelect={() => setPanel("edit")}>
                <Pencil size={14} /> Modifica titolo e testi
              </DropdownMenuItem>
              {clip.status === "COMPLETED" && (
                <DropdownMenuItem onSelect={() => setPanel("trim")}>
                  <Scissors size={14} /> Taglia inizio/fine
                </DropdownMenuItem>
              )}
              {clip.format === "longform" && (
                <DropdownMenuItem
                  disabled={busy !== null}
                  onSelect={() => call("title", `/api/clips/${clip.id}/regenerate-title`, { method: "POST" }, "Titolo rigenerato.")}
                >
                  <Wand2 size={14} /> Rigenera titolo con l&apos;AI
                </DropdownMenuItem>
              )}
            </DropdownMenuContent>
          </DropdownMenu>
          {busy === "title" && <Loader2 size={14} className="animate-spin text-muted" />}
        </div>

        {error && <p className="rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-2 text-xs text-red-200">{error}</p>}
        {notice && <p className="rounded-lg border border-emerald-500/30 bg-emerald-500/10 px-3 py-2 text-xs text-emerald-200">{notice}</p>}
        {clip.errorMessage && clip.status === "FAILED" && (
          <p className="rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-2 text-xs text-red-200">Errore del render: {clip.errorMessage}</p>
        )}

        <PublishStatus
          clipId={clip.id}
          status={clip.youtubePublishStatus}
          youtubeUrl={clip.youtubeUrl}
          youtubeError={clip.youtubeError}
          youtubePublishAt={clip.youtubePublishAt}
          youtubeCancelledAt={clip.youtubeCancelledAt}
        />
        {!youtubeConnected && clip.status === "COMPLETED" && <p className="text-xs text-faint">Collega YouTube dalle Opzioni per pubblicare da qui.</p>}

        <div className="border-t border-line pt-5">
          {panel === "info" && <ClipInfo clip={clip} />}
          {panel === "edit" && <EditPanel clip={clip} onDone={(msg) => { setPanel("info"); setNotice(msg); }} onCancel={() => setPanel("info")} />}
          {panel === "trim" && (
            <TrimPanel
              clipId={clip.id}
              duration={clip.duration}
              getCurrentTime={clip.videoUrl ? () => videoRef.current?.currentTime ?? null : undefined}
              onDone={() => { setPanel("info"); setNotice("Taglio applicato: il video si sta rigenerando."); }}
              onCancel={() => setPanel("info")}
            />
          )}
          {panel === "publish" && (
            <PublishPanel
              clipId={clip.id}
              defaultTitle={clip.title}
              defaultDescription={clip.publishDescription}
              defaultHashtags={clip.hashtags}
              onDone={() => { setPanel("info"); setNotice("Inviata a YouTube."); }}
              onCancel={() => setPanel("info")}
            />
          )}
        </div>
      </div>
      {confirm.element}
    </div>
  );
}

function ClipInfo({ clip }: { clip: ClipViewModel }) {
  return (
    <div className="space-y-5">
      <ScoreBars scores={clip.scores} />
      <div className="space-y-2">
        <p className="text-[11px] font-medium uppercase tracking-wider text-faint">Gancio</p>
        <p className="text-sm text-ink">&ldquo;{clip.hook}&rdquo;</p>
        <p className="text-sm leading-relaxed text-muted">{clip.reason}</p>
      </div>
      {clip.badges.length > 0 && (
        <div className="flex flex-wrap gap-1.5">
          {clip.badges.map((badge) => (
            <span key={badge} className="chip text-ink">
              {BADGE_LABELS[badge]}
            </span>
          ))}
        </div>
      )}
      {clip.hashtags.length > 0 && <p className="text-xs leading-relaxed text-brand-300">{clip.hashtags.map((h) => `#${h}`).join(" ")}</p>}
    </div>
  );
}

function ScoreBars({ scores }: { scores: ClipScores }) {
  const entries: Array<[string, number]> = [
    ["Gancio", scores.hook],
    ["Ritenzione", scores.retention],
    ["Emozione", scores.emotion],
    ["Chiarezza", scores.clarity],
    ["Payoff", scores.payoff],
    ["Viralità", scores.virality],
  ];
  return (
    <div className="grid grid-cols-2 gap-x-5 gap-y-2.5">
      {entries.map(([label, value]) => (
        <div key={label} className="space-y-1">
          <div className="flex justify-between text-xs">
            <span className="text-muted">{label}</span>
            <span className={`font-medium tabular-nums ${scoreTone(value).text}`}>{value}</span>
          </div>
          <div className="h-1 overflow-hidden rounded-full bg-overlay">
            <div className="h-full rounded-full" style={{ width: `${value}%`, backgroundColor: scoreTone(value).ring }} />
          </div>
        </div>
      ))}
    </div>
  );
}

function EditPanel({ clip, onDone, onCancel }: { clip: ClipViewModel; onDone: (message: string) => void; onCancel: () => void }) {
  const router = useRouter();
  const [title, setTitle] = useState(clip.title);
  const [description, setDescription] = useState(clip.publishDescription);
  const [hashtags, setHashtags] = useState(clip.hashtags.join(" "));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function save(e: React.FormEvent) {
    e.preventDefault();
    setSaving(true);
    setError(null);
    try {
      const res = await fetch(`/api/clips/${clip.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          title: title.trim(),
          publishDescription: description,
          // Si accettano sia "#tag" sia "tag", separati da spazi o virgole.
          hashtags: hashtags
            .split(/[\s,]+/)
            .map((h) => h.replace(/^#/, "").trim())
            .filter(Boolean),
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "Salvataggio fallito");
      router.refresh();
      onDone(data.pendingJobsUpdated > 0 ? "Salvato, e aggiornata anche la pubblicazione già programmata." : "Salvato.");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Errore imprevisto");
    } finally {
      setSaving(false);
    }
  }

  return (
    <form onSubmit={save} className="space-y-4">
      <p className="section-title">Modifica testi</p>
      <div>
        <label className="label">
          Titolo <span className="text-faint">({title.length}/100)</span>
        </label>
        <input value={title} maxLength={100} onChange={(e) => setTitle(e.target.value)} className="input" />
      </div>
      <div>
        <label className="label">Descrizione</label>
        <textarea value={description} rows={5} onChange={(e) => setDescription(e.target.value)} className="input" />
        <p className="mt-1.5 text-xs text-faint">Svuota il campo per tornare alla descrizione generata automaticamente.</p>
      </div>
      <div>
        <label className="label">Hashtag</label>
        <input value={hashtags} onChange={(e) => setHashtags(e.target.value)} placeholder="blur reaction gtavi" className="input" />
      </div>
      {error && <p className="text-xs text-red-400">{error}</p>}
      <div className="flex gap-2">
        <button type="submit" disabled={saving || title.trim().length === 0} className="btn btn-primary btn-sm">
          {saving ? <Loader2 size={14} className="animate-spin" /> : <RefreshCw size={14} />}
          {saving ? "Salvo…" : "Salva"}
        </button>
        <button type="button" onClick={onCancel} className="btn btn-secondary btn-sm">
          Indietro
        </button>
      </div>
    </form>
  );
}
