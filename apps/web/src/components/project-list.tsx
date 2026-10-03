import Link from "next/link";
import { AlertTriangle, Clapperboard, Film, Radio } from "lucide-react";
import type { ProjectSummary } from "@/lib/data/projects";
import { StatusBadge, isProcessingStatus } from "./status-badge";
import { CancelProjectButton } from "./cancel-project-button";
import { DeleteSourceButton } from "./delete-source-button";
import { ProcessingProgressBar } from "./processing-progress-bar";
import { statusMessage } from "@/lib/status-message";
import { EmptyState, ScoreRing, formatDuration } from "./ui";

/**
 * Griglia dei progetti. Le schede non sono più riquadri con bordo: la copertina è la scheda (come
 * su YouTube e Twitch), il testo sta sotto senza cornice. Con featureFirst il primo progetto prende
 * due colonne: è quasi sempre quello che simo sta per aprire.
 */
export function ProjectList({ summaries, emptyMessage, featureFirst = false }: { summaries: ProjectSummary[]; emptyMessage: string; featureFirst?: boolean }) {
  if (summaries.length === 0) {
    return <EmptyState icon={<Clapperboard size={20} />} title="Niente da mostrare" description={emptyMessage} />;
  }

  return (
    <div className="grid grid-cols-1 gap-x-5 gap-y-8 sm:grid-cols-2 xl:grid-cols-3">
      {summaries.map((summary, i) => (
        <ProjectCard key={summary.project.id} summary={summary} featured={featureFirst && i === 0} />
      ))}
    </div>
  );
}

function dateLabel(iso: string): string {
  return new Date(iso).toLocaleDateString("it-IT", { day: "numeric", month: "short" });
}

function ProjectCard({ summary, featured }: { summary: ProjectSummary; featured: boolean }) {
  const { project, video, clipCount, completedClipCount, topScore, coverUrl } = summary;
  const processing = isProcessingStatus(project.status);
  const failed = project.status === "FAILED";
  const isVod = project.source_type === "twitch_vod";

  return (
    <article className={`group relative flex flex-col gap-3 ${featured ? "sm:col-span-2 xl:row-span-2" : ""}`}>
      <Link
        href={`/dashboard/projects/${project.id}`}
        className="relative block aspect-video overflow-hidden rounded-2xl bg-raised ring-1 ring-white/[0.06] transition duration-300 ease-out group-hover:ring-white/20 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-400"
      >
        {coverUrl ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={coverUrl}
            alt=""
            loading="lazy"
            className={`h-full w-full object-cover transition duration-500 ease-out group-hover:scale-[1.04] ${failed ? "opacity-40 grayscale" : ""}`}
          />
        ) : (
          <div className="flex h-full w-full items-center justify-center bg-overlay">
            {isVod ? <Radio size={28} className="text-twitch-400" /> : <Film size={28} className="text-faint" />}
          </div>
        )}
        <div className="pointer-events-none absolute inset-0 bg-gradient-to-t from-black/75 via-black/0 to-black/25" />

        <div className="absolute left-3 top-3 flex items-center gap-1.5">
          {(processing || failed) && <StatusBadge status={project.status} className="backdrop-blur" />}
          {isVod && (
            <span className="inline-flex items-center gap-1 rounded-md bg-twitch-500/90 px-1.5 py-0.5 text-[11px] font-bold text-white" title="VOD Twitch">
              <Radio size={11} strokeWidth={2.6} /> VOD
            </span>
          )}
        </div>
        {topScore !== null && (
          <div className="absolute right-3 top-3">
            <ScoreRing score={topScore} size={featured ? 46 : 40} />
          </div>
        )}

        {featured && (
          <h3
            className="absolute inset-x-4 bottom-4 line-clamp-2 max-w-2xl text-xl font-extrabold leading-tight tracking-tight text-white drop-shadow-[0_2px_8px_rgba(0,0,0,0.8)] sm:inset-x-5 sm:bottom-5 sm:text-2xl"
            style={{ fontStretch: "110%" }}
          >
            {project.title}
          </h3>
        )}
        {video?.duration_seconds ? (
          <span
            className={`absolute right-3 rounded-md bg-black/70 px-1.5 py-0.5 text-[11px] font-semibold tabular-nums text-white backdrop-blur ${featured ? "top-14 sm:top-auto sm:bottom-5" : "bottom-3"}`}
          >
            {formatDuration(video.duration_seconds)}
          </span>
        ) : null}
      </Link>

      <div className="flex min-w-0 flex-col gap-1.5 px-0.5">
        {!featured && (
          <Link href={`/dashboard/projects/${project.id}`} className="line-clamp-2 font-semibold leading-snug text-ink transition group-hover:text-white">
            {project.title}
          </Link>
        )}
        {processing ? (
          <div className="space-y-1.5 pt-1">
            <ProcessingProgressBar status={project.status} showSteps={false} />
            <p className="text-xs text-muted">{statusMessage(project.status, project.source_type)}</p>
          </div>
        ) : null}
        <div className="flex items-center justify-between gap-2 text-[13px] text-muted">
          <p className="min-w-0 truncate">
            {failed ? (
              <span className="inline-flex items-center gap-1 text-red-300">
                <AlertTriangle size={13} /> Non riuscito
              </span>
            ) : clipCount > 0 ? (
              <>
                <span className="font-semibold text-ink">{clipCount}</span> clip
                {completedClipCount > 0 && (
                  <>
                    , <span className="font-semibold text-ink">{completedClipCount}</span> pronte
                  </>
                )}
              </>
            ) : processing ? null : (
              "Nessuna clip"
            )}
            {!processing && <span className="text-faint"> · {dateLabel(project.created_at)}</span>}
          </p>
          <div className="flex shrink-0 items-center gap-1.5">
            {processing && <CancelProjectButton projectId={project.id} compact />}
            {video?.storage_path && <DeleteSourceButton projectId={project.id} compact />}
          </div>
        </div>
      </div>
    </article>
  );
}

/** Riga compatta di un progetto in lavorazione: miniatura, titolo, fase e barra, si legge al volo. */
export function WorkingRow({ summary }: { summary: ProjectSummary }) {
  const { project, video, coverUrl } = summary;
  const isVod = project.source_type === "twitch_vod";
  return (
    <div className="group flex items-center gap-4 p-3 sm:p-4">
      <Link
        href={`/dashboard/projects/${project.id}`}
        className="relative aspect-video w-28 shrink-0 overflow-hidden rounded-lg bg-raised sm:w-36"
        aria-label={project.title}
      >
        {coverUrl ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={coverUrl} alt="" loading="lazy" className="h-full w-full object-cover" />
        ) : (
          <div className="flex h-full w-full items-center justify-center">{isVod ? <Radio size={20} className="text-twitch-400" /> : <Film size={20} className="text-faint" />}</div>
        )}
        {video?.duration_seconds ? (
          <span className="absolute bottom-1 right-1 rounded bg-black/75 px-1 text-[10px] font-semibold tabular-nums text-white">{formatDuration(video.duration_seconds)}</span>
        ) : null}
      </Link>
      <div className="min-w-0 flex-1 space-y-2">
        <div className="flex items-start justify-between gap-3">
          <Link href={`/dashboard/projects/${project.id}`} className="line-clamp-1 text-sm font-semibold text-ink hover:text-white sm:text-[15px]">
            {project.title}
          </Link>
          <CancelProjectButton projectId={project.id} compact />
        </div>
        <ProcessingProgressBar status={project.status} showSteps={false} />
        <p className="text-xs text-muted">
          <span className="font-semibold text-brand-300">{statusMessage(project.status, project.source_type)}</span>
          {isVod && <span className="text-faint"> · VOD Twitch</span>}
        </p>
      </div>
    </div>
  );
}
