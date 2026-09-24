import Link from "next/link";
import { notFound } from "next/navigation";
import { ArrowLeft, Clock, Film, Radio } from "lucide-react";
import { requireUser } from "@/lib/auth";
import { StatusBadge, isProcessingStatus } from "@/components/status-badge";
import { ProcessingProgressBar } from "@/components/processing-progress-bar";
import { PollingRefresher } from "@/components/polling-refresher";
import { ClipList } from "@/components/clip-list";
import { UsageStatsPanel } from "@/components/usage-stats-panel";
import { RetryProjectButton } from "@/components/retry-project-button";
import { CancelProjectButton } from "@/components/cancel-project-button";
import { Alert, formatDuration } from "@/components/ui";
import { fetchProjectDetails, fetchYoutubeConnected } from "@/lib/data/clips";
import { statusMessage } from "@/lib/status-message";

// Vedi commento in dashboard/batch/page.tsx: senza questo, su Vercel i dati possono restare
// cachati anche col polling attivo.
export const dynamic = "force-dynamic";

export default async function ProjectDetailPage({ params }: { params: { id: string } }) {
  const { supabase, user } = await requireUser();

  const [details, youtubeConnected] = await Promise.all([fetchProjectDetails(supabase, [params.id]), fetchYoutubeConnected(supabase, user.id)]);
  const detail = details.get(params.id);
  if (!detail) {
    notFound();
  }
  const { project, video, clips } = detail;

  const projectProcessing = isProcessingStatus(project.status);
  const anyClipInFlight = clips.some((c) => c.status === "QUEUED" || c.status === "RENDERING");
  const anyPublishInFlight = clips.some((c) => c.youtubePublishStatus === "PENDING" || c.youtubePublishStatus === "UPLOADING");
  const pollingActive = projectProcessing || anyClipInFlight || anyPublishInFlight;
  const isVod = project.source_type === "twitch_vod";
  const readyCount = clips.filter((c) => c.status === "COMPLETED").length;

  return (
    <div className="mx-auto max-w-7xl space-y-8">
      <PollingRefresher active={pollingActive} />

      <div className="space-y-4">
        <Link href="/dashboard" className="inline-flex items-center gap-1.5 text-sm text-muted transition hover:text-ink">
          <ArrowLeft size={15} /> Progetti
        </Link>
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div className="min-w-0 space-y-2">
            <h1 className="break-words font-display text-2xl font-semibold tracking-tight text-ink sm:text-3xl">{project.title}</h1>
            <div className="flex flex-wrap items-center gap-2 text-xs text-muted">
              <StatusBadge status={project.status} />
              <span className="chip">
                {isVod ? <Radio size={12} /> : <Film size={12} />}
                {isVod ? "VOD Twitch · video lunghi" : "Shorts"}
              </span>
              {video?.duration_seconds ? (
                <span className="chip">
                  <Clock size={12} /> {formatDuration(video.duration_seconds)}
                </span>
              ) : null}
              {clips.length > 0 && (
                <span className="chip">
                  {clips.length} clip · {readyCount} pronte
                </span>
              )}
            </div>
          </div>
        </div>
      </div>

      {project.status === "FAILED" && (
        <Alert>
          <p>Elaborazione fallita: {project.error_message ?? video?.error_message ?? "errore sconosciuto"}</p>
          <div className="mt-3">
            <RetryProjectButton projectId={project.id} />
          </div>
        </Alert>
      )}

      {projectProcessing && (
        <div className="card space-y-4 p-6">
          <div className="flex items-center justify-between gap-3">
            <div className="flex items-center gap-3">
              <span className="relative flex h-2.5 w-2.5">
                <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-brand-400/60" />
                <span className="relative inline-flex h-2.5 w-2.5 rounded-full bg-brand-400" />
              </span>
              <p className="text-sm text-ink">{statusMessage(project.status, project.source_type)}</p>
            </div>
            <CancelProjectButton projectId={project.id} compact />
          </div>
          <ProcessingProgressBar status={project.status} />
        </div>
      )}

      {clips.length > 0 && <ClipList clips={clips} youtubeConnected={youtubeConnected} />}

      {video?.usageStats && <UsageStatsPanel stats={video.usageStats} />}
    </div>
  );
}
