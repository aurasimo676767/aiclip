import Link from "next/link";
import { requireUser } from "@/lib/auth";
import { StatusBadge, isProcessingStatus } from "@/components/status-badge";
import { ProcessingProgressBar } from "@/components/processing-progress-bar";
import { PollingRefresher } from "@/components/polling-refresher";
import { ClipList } from "@/components/clip-list";
import { RetryProjectButton } from "@/components/retry-project-button";
import { CancelProjectButton } from "@/components/cancel-project-button";
import { fetchProjectDetails, fetchYoutubeConnected } from "@/lib/data/clips";
import { Alert, EmptyState, PageHeader, formatDuration } from "@/components/ui";

// Senza questo, su Vercel (produzione) Next.js può servire dati Supabase cachati anche col
// polling attivo lato client (router.refresh() non basta a bypassare la Data Cache di fetch()
// per le richieste interne di supabase-js) — la pagina sembrava "non aggiornarsi mai" pur
// avendo il worker che completava job in continuazione. In `next dev` questo non si nota perché
// il dev server ha semantiche di cache diverse.
export const dynamic = "force-dynamic";
import { statusMessage } from "@/lib/status-message";

export default async function BatchReviewPage({ searchParams }: { searchParams: { ids?: string } }) {
  const { supabase, user } = await requireUser();

  const projectIds = (searchParams.ids ?? "")
    .split(",")
    .map((id) => id.trim())
    .filter(Boolean);

  if (projectIds.length === 0) {
    return (
      <div className="mx-auto max-w-3xl">
        <EmptyState
          title="Nessun progetto da mostrare"
          action={
            <Link href="/dashboard" className="btn btn-secondary btn-sm">
              Torna alla home
            </Link>
          }
        />
      </div>
    );
  }

  const [details, youtubeConnected] = await Promise.all([
    fetchProjectDetails(supabase, projectIds),
    fetchYoutubeConnected(supabase, user.id),
  ]);

  const columns = projectIds.map((id) => details.get(id)).filter((d): d is NonNullable<typeof d> => Boolean(d));

  const pollingActive = columns.some((d) => {
    const processing = isProcessingStatus(d.project.status);
    const anyClipInFlight = d.clips.some((c) => c.status === "QUEUED" || c.status === "RENDERING");
    const anyPublishInFlight = d.clips.some((c) => c.youtubePublishStatus === "PENDING" || c.youtubePublishStatus === "UPLOADING");
    return processing || anyClipInFlight || anyPublishInFlight;
  });

  return (
    <div className="space-y-6">
      <PollingRefresher active={pollingActive} />

      <PageHeader
        title="Generazione multipla"
        description={`${columns.length} video — ogni colonna si aggiorna da sola.`}
      />

      <div className="-mx-4 flex gap-4 overflow-x-auto px-4 pb-4 sm:-mx-6 sm:px-6 md:-mx-10 md:px-10">
        {columns.map(({ project, video, clips }) => {
          const processing = isProcessingStatus(project.status);

          return (
            <div key={project.id} className="card w-[23rem] shrink-0 space-y-4 p-4">
              <div className="space-y-2">
                <Link href={`/dashboard/projects/${project.id}`} className="line-clamp-2 font-medium leading-snug text-ink hover:text-brand-200">
                  {project.title}
                </Link>
                <div className="flex flex-wrap items-center gap-2">
                  <StatusBadge status={project.status} />
                  {video?.duration_seconds ? <span className="text-xs text-faint">{formatDuration(video.duration_seconds)}</span> : null}
                </div>
              </div>

              {project.status === "FAILED" && (
                <Alert>
                  <p className="text-xs">Errore: {project.error_message ?? video?.error_message ?? "sconosciuto"}</p>
                  <div className="mt-2">
                    <RetryProjectButton projectId={project.id} />
                  </div>
                </Alert>
              )}

              {processing && clips.length === 0 && (
                <div className="space-y-3 rounded-xl border border-line bg-raised/50 p-4">
                  <p className="text-xs text-muted">{statusMessage(project.status, project.source_type)}</p>
                  <ProcessingProgressBar status={project.status} showSteps={false} />
                  <CancelProjectButton projectId={project.id} compact />
                </div>
              )}

              {clips.length > 0 && <ClipList clips={clips} youtubeConnected={youtubeConnected} compact />}
            </div>
          );
        })}
      </div>
    </div>
  );
}
