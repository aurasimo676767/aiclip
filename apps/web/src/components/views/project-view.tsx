import Link from "next/link";
import { ArrowLeft, Clock, Film, Radio } from "lucide-react";
import { overallScore, type DiscardedShort } from "@clipforge/shared";
import type { ProjectDetail } from "@/lib/data/clips";
import { StatusBadge, isProcessingStatus } from "@/components/status-badge";
import { ProcessingProgressBar } from "@/components/processing-progress-bar";
import { ClipList } from "@/components/clip-list";
import { DiscardedShortsPanel } from "@/components/discarded-shorts-panel";
import { UsageStatsPanel } from "@/components/usage-stats-panel";
import { RetryProjectButton } from "@/components/retry-project-button";
import { CancelProjectButton } from "@/components/cancel-project-button";
import { Alert, formatDuration } from "@/components/ui";
import { statusMessage } from "@/lib/status-message";

/** Corpo della pagina di un progetto, separato per poterlo provare in /dev-preview con dati finti. */
export function ProjectView({
  detail,
  youtubeConnected,
  discardedVideoId,
  discardedShorts,
}: {
  detail: ProjectDetail;
  youtubeConnected: boolean;
  discardedVideoId: string | null;
  discardedShorts: DiscardedShort[];
}) {
  const { project, video, clips } = detail;
  const projectProcessing = isProcessingStatus(project.status);
  const isVod = project.source_type === "twitch_vod";
  const readyCount = clips.filter((c) => c.status === "COMPLETED").length;
  const best = [...clips].filter((c) => c.thumbnailUrl).sort((x, y) => overallScore(y.scores) - overallScore(x.scores))[0];
  const backdrop = clips.find((c) => c.format === "longform" && c.thumbnailUrl)?.thumbnailUrl ?? best?.thumbnailUrl ?? null;

  return (
    <div className="mx-auto max-w-7xl space-y-7">
      {/* Testata "da copertina": dietro al titolo la miniatura della clip migliore, sfocata e sfumata
          nel fondo, come la pagina di un album. Il titolo è largo e pesante come i titoli dei video. */}
      <header className="relative isolate -mx-4 -mt-5 overflow-hidden px-4 pb-2 pt-5 sm:-mx-6 sm:px-6 md:-mx-10 md:-mt-10 md:px-10 md:pt-10">
        {backdrop && (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={backdrop}
            alt=""
            aria-hidden
            className="absolute inset-0 -z-10 h-full w-full scale-110 object-cover opacity-60 blur-2xl saturate-150 [mask-image:linear-gradient(to_bottom,black,transparent)]"
          />
        )}
        <div className="space-y-4">
          <Link href="/dashboard" className="inline-flex items-center gap-1.5 text-sm font-medium text-muted transition hover:text-ink">
            <ArrowLeft size={15} /> Progetti
          </Link>
          <h1 className="max-w-4xl break-words text-[1.7rem] font-extrabold leading-[1.08] tracking-tight text-white sm:text-4xl" style={{ fontStretch: "110%" }}>
            {project.title}
          </h1>
          <p className="flex flex-wrap items-center gap-x-2 gap-y-1.5 text-sm text-muted">
            {project.status !== "READY" && <StatusBadge status={project.status} />}
            <span className="inline-flex items-center gap-1.5">
              {isVod ? <Radio size={14} className="text-twitch-300" /> : <Film size={14} />}
              {isVod ? "VOD Twitch" : "Video YouTube"}
            </span>
            {video?.duration_seconds ? (
              <>
                <span className="text-faint">·</span>
                <span className="inline-flex items-center gap-1.5 tabular-nums">
                  <Clock size={14} /> {formatDuration(video.duration_seconds)}
                </span>
              </>
            ) : null}
            {clips.length > 0 && (
              <>
                <span className="text-faint">·</span>
                <span>
                  <span className="font-semibold text-ink">{clips.length}</span> clip, <span className="font-semibold text-ink">{readyCount}</span> pronte
                </span>
              </>
            )}
          </p>
        </div>
      </header>

      {project.status === "FAILED" && (
        <Alert>
          <p>Elaborazione fallita: {project.error_message ?? video?.error_message ?? "errore sconosciuto"}</p>
          <div className="mt-3">
            <RetryProjectButton projectId={project.id} />
          </div>
        </Alert>
      )}

      {projectProcessing && (
        <div className="card space-y-5 p-5 sm:p-6">
          <div className="flex items-center justify-between gap-3">
            <div className="flex items-center gap-3">
              <span className="relative flex h-2.5 w-2.5">
                <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-brand-400/60" />
                <span className="relative inline-flex h-2.5 w-2.5 rounded-full bg-brand-400" />
              </span>
              <p className="text-base font-bold text-ink sm:text-lg" style={{ fontStretch: "108%" }}>{statusMessage(project.status, project.source_type)}</p>
            </div>
            <CancelProjectButton projectId={project.id} compact />
          </div>
          <ProcessingProgressBar status={project.status} />
        </div>
      )}

      {clips.length > 0 && <ClipList clips={clips} youtubeConnected={youtubeConnected} />}

      {discardedVideoId && discardedShorts.length > 0 && <DiscardedShortsPanel videoId={discardedVideoId} items={discardedShorts} />}

      {video?.usageStats && <UsageStatsPanel stats={video.usageStats} />}
    </div>
  );
}
