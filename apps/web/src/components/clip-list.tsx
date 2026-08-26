"use client";

import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { overallScore, type ClipScores, type ClipBadge } from "@clipforge/shared";
import { StatusBadge } from "./status-badge";
import { PublishYoutubeButton } from "./publish-youtube-button";
import { TrimClipButton } from "./trim-clip-button";

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
  youtubePublishStatus: string | null;
  youtubeUrl: string | null;
  youtubeError: string | null;
  youtubePublishAt: string | null;
  badges: ClipBadge[];
}

const BADGE_LABELS: Record<ClipBadge, string> = {
  gotcha: "🎯 Gotcha",
  cliffhanger: "⏳ Cliffhanger",
  controversial: "🔥 Controverso",
  relatable: "🙃 Relatable",
  high_energy: "⚡ Energia alta",
};

export function ClipList({ clips, youtubeConnected }: { clips: ClipViewModel[]; youtubeConnected: boolean }) {
  const router = useRouter();
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [submitting, setSubmitting] = useState(false);
  const [previewUrls, setPreviewUrls] = useState<Record<string, string>>({});
  const [previewLoading, setPreviewLoading] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [retryingClipId, setRetryingClipId] = useState<string | null>(null);

  const sorted = useMemo(
    () => [...clips].sort((a, b) => overallScore(b.scores) - overallScore(a.scores)),
    [clips],
  );

  function toggle(id: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  async function handleGenerate() {
    if (selected.size === 0) return;
    setSubmitting(true);
    setError(null);
    try {
      const res = await fetch("/api/clips/render", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ clipIds: [...selected] }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "Richiesta fallita");
      setSelected(new Set());
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Errore imprevisto");
    } finally {
      setSubmitting(false);
    }
  }

  async function retryClip(clipId: string) {
    setRetryingClipId(clipId);
    setError(null);
    try {
      const res = await fetch("/api/clips/render", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ clipIds: [clipId] }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "Riprova fallita");
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Errore imprevisto");
    } finally {
      setRetryingClipId(null);
    }
  }

  async function loadPreview(clipId: string) {
    setPreviewLoading(clipId);
    setError(null);
    try {
      const res = await fetch(`/api/clips/${clipId}/download`);
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "Impossibile caricare la clip");
      setPreviewUrls((prev) => ({ ...prev, [clipId]: data.url }));
    } catch (err) {
      setError(err instanceof Error ? err.message : "Errore imprevisto");
    } finally {
      setPreviewLoading(null);
    }
  }

  const selectableCount = sorted.filter((c) => c.status === "SUGGESTED" || c.status === "FAILED").length;

  return (
    <div className="space-y-4">
      {error && <p className="text-sm text-red-400">{error}</p>}

      {selectableCount > 0 && (
        <div className="flex items-center justify-between rounded-lg border border-zinc-800 bg-zinc-900/60 px-4 py-3">
          <p className="text-sm text-zinc-400">{selected.size} clip selezionate</p>
          <button
            onClick={handleGenerate}
            disabled={selected.size === 0 || submitting}
            className="rounded-lg bg-brand-500 px-4 py-2 text-sm font-medium text-white transition hover:bg-brand-600 disabled:opacity-50"
          >
            {submitting ? "Invio..." : "Generate Shorts"}
          </button>
        </div>
      )}

      <ul className="space-y-3">
        {sorted.map((clip, index) => {
          const score = overallScore(clip.scores);
          const canSelect = clip.status === "SUGGESTED" || clip.status === "FAILED";
          const canPreview = clip.status === "COMPLETED";
          const previewUrl = previewUrls[clip.id];

          return (
            <li key={clip.id} className="rounded-xl border border-zinc-800 bg-zinc-900/40 p-5">
              <div className="flex items-start gap-4">
                {canSelect && (
                  <input
                    type="checkbox"
                    checked={selected.has(clip.id)}
                    onChange={() => toggle(clip.id)}
                    className="mt-1.5 h-4 w-4 rounded border-zinc-600 bg-zinc-800 text-brand-500"
                  />
                )}
                <div className="min-w-0 flex-1 space-y-2">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <h3 className="min-w-0 break-words font-medium text-white">
                      Clip #{index + 1} — {clip.title}
                    </h3>
                    <div className="flex shrink-0 items-center gap-2">
                      <span className="rounded-full bg-brand-500/15 px-2.5 py-0.5 text-xs font-semibold text-brand-200">
                        Score {score}
                      </span>
                      <StatusBadge status={clip.status} />
                    </div>
                  </div>
                  <p className="text-sm text-zinc-400">
                    {Math.round(clip.duration)}s — Hook: &ldquo;{clip.hook}&rdquo;
                  </p>
                  <p className="text-sm text-zinc-500">{clip.reason}</p>
                  {clip.badges.length > 0 && (
                    <div className="flex flex-wrap gap-1.5">
                      {clip.badges.map((badge) => (
                        <span
                          key={badge}
                          className="rounded-full bg-zinc-800 px-2.5 py-0.5 text-xs font-medium text-zinc-200"
                        >
                          {BADGE_LABELS[badge]}
                        </span>
                      ))}
                    </div>
                  )}
                  {clip.hashtags.length > 0 && (
                    <p className="text-xs text-brand-300/80">{clip.hashtags.map((h) => `#${h}`).join(" ")}</p>
                  )}
                  {clip.errorMessage && (
                    <div className="space-y-1">
                      <p className="text-sm text-red-400">Errore: {clip.errorMessage}</p>
                      <button
                        onClick={() => retryClip(clip.id)}
                        disabled={retryingClipId === clip.id}
                        className="rounded-lg border border-red-400/40 px-3 py-1.5 text-xs font-medium text-red-200 hover:border-red-400 disabled:opacity-50"
                      >
                        {retryingClipId === clip.id ? "Rimetto in coda..." : "Riprova"}
                      </button>
                    </div>
                  )}

                  <ScoreBreakdown scores={clip.scores} />

                  {canPreview && (
                    <div className="pt-2">
                      {previewUrl ? (
                        <video src={previewUrl} controls className="aspect-[9/16] w-48 rounded-lg bg-black" />
                      ) : (
                        <div className="flex gap-2">
                          <button
                            onClick={() => loadPreview(clip.id)}
                            disabled={previewLoading === clip.id}
                            className="rounded-lg border border-zinc-700 px-3 py-1.5 text-xs font-medium text-zinc-200 hover:border-zinc-500"
                          >
                            {previewLoading === clip.id ? "Caricamento..." : "Preview"}
                          </button>
                        </div>
                      )}
                      {previewUrl && (
                        <a
                          href={previewUrl}
                          download
                          className="mt-2 inline-block text-xs text-brand-300 hover:underline"
                        >
                          Scarica MP4
                        </a>
                      )}

                      <div className="mt-2">
                        <TrimClipButton clipId={clip.id} duration={clip.duration} />
                      </div>

                      {youtubeConnected ? (
                        <div className="mt-2">
                          <PublishYoutubeButton
                            clipId={clip.id}
                            defaultTitle={clip.title}
                            defaultDescription={clip.caption}
                            defaultHashtags={clip.hashtags}
                            status={clip.youtubePublishStatus}
                            youtubeUrl={clip.youtubeUrl}
                            youtubeError={clip.youtubeError}
                            youtubePublishAt={clip.youtubePublishAt}
                          />
                        </div>
                      ) : (
                        <p className="mt-2 text-xs text-zinc-600">
                          Collega YouTube dalle Impostazioni per pubblicare direttamente.
                        </p>
                      )}
                    </div>
                  )}
                </div>
              </div>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

function ScoreBreakdown({ scores }: { scores: ClipScores }) {
  const entries: Array<[string, number]> = [
    ["Hook", scores.hook],
    ["Retention", scores.retention],
    ["Emotion", scores.emotion],
    ["Clarity", scores.clarity],
    ["Payoff", scores.payoff],
    ["Virality", scores.virality],
  ];

  return (
    <div className="grid grid-cols-3 gap-x-4 gap-y-1 pt-1 sm:grid-cols-6">
      {entries.map(([label, value]) => (
        <div key={label} className="text-xs text-zinc-500">
          <span className="block text-zinc-400">{label}</span>
          {value}
        </div>
      ))}
    </div>
  );
}
