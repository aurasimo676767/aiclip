import Link from "next/link";
import { requireUser } from "@/lib/auth";
import { StatusBadge, isProcessingStatus } from "@/components/status-badge";
import { ProcessingProgressBar } from "@/components/processing-progress-bar";
import { PollingRefresher } from "@/components/polling-refresher";
import { ClipList } from "@/components/clip-list";
import { RetryProjectButton } from "@/components/retry-project-button";
import { CancelProjectButton } from "@/components/cancel-project-button";
import { fetchProjectDetails, fetchYoutubeConnected } from "@/lib/data/clips";

// Senza questo, su Vercel (produzione) Next.js può servire dati Supabase cachati anche col
// polling attivo lato client (router.refresh() non basta a bypassare la Data Cache di fetch()
// per le richieste interne di supabase-js) — la pagina sembrava "non aggiornarsi mai" pur
// avendo il worker che completava job in continuazione. In `next dev` questo non si nota perché
// il dev server ha semantiche di cache diverse.
export const dynamic = "force-dynamic";
import { statusMessage } from "@/app/dashboard/projects/[id]/page";

export default async function BatchReviewPage({ searchParams }: { searchParams: { ids?: string } }) {
  const { supabase, user } = await requireUser();

  const projectIds = (searchParams.ids ?? "")
    .split(",")
    .map((id) => id.trim())
    .filter(Boolean);

  if (projectIds.length === 0) {
    return (
      <div className="mx-auto max-w-4xl">
        <p className="text-sm text-zinc-400">
          Nessun progetto da mostrare.{" "}
          <Link href="/dashboard" className="text-brand-300 hover:underline">
            Torna alla dashboard
          </Link>
          .
        </p>
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
    <div className="space-y-4">
      <PollingRefresher active={pollingActive} />

      <div>
        <h1 className="text-2xl font-semibold text-white">Generazione multipla</h1>
        <p className="mt-1 text-sm text-zinc-500">
          {columns.length} video in elaborazione — ogni colonna si aggiorna da sola, puoi generare le clip che vuoi da ognuna.
        </p>
      </div>

      <div className="flex gap-4 overflow-x-auto pb-4">
        {columns.map(({ project, video, clips }) => {
          const processing = isProcessingStatus(project.status);

          return (
            <div key={project.id} className="w-[22rem] shrink-0 space-y-3 rounded-xl border border-zinc-800 bg-zinc-900/40 p-4">
              <div className="space-y-1">
                <div className="flex items-start justify-between gap-2">
                  <Link
                    href={`/dashboard/projects/${project.id}`}
                    className="min-w-0 break-words font-medium text-white hover:underline"
                  >
                    {project.title}
                  </Link>
                  <StatusBadge status={project.status} />
                </div>
                {video && (
                  <p className="break-words text-xs text-zinc-500">
                    {video.original_filename}
                    {video.duration_seconds ? ` — ${Math.round(video.duration_seconds / 60)} min` : ""}
                  </p>
                )}
              </div>

              {project.status === "FAILED" && (
                <div className="rounded-lg border border-red-500/30 bg-red-500/10 p-3 text-xs text-red-300">
                  <p>Errore: {project.error_message ?? video?.error_message ?? "sconosciuto"}</p>
                  <RetryProjectButton projectId={project.id} />
                </div>
              )}

              {processing && clips.length === 0 && (
                <div className="space-y-2 rounded-lg border border-zinc-800 bg-zinc-950/40 p-4">
                  <div className="flex items-center gap-2">
                    <span className="h-2 w-2 animate-pulse rounded-full bg-brand-400" />
                    <p className="text-xs text-zinc-400">{statusMessage(project.status, project.source_type)}</p>
                  </div>
                  <ProcessingProgressBar status={project.status} />
                  <CancelProjectButton projectId={project.id} compact />
                </div>
              )}

              {clips.length > 0 && <ClipList clips={clips} youtubeConnected={youtubeConnected} />}
            </div>
          );
        })}
      </div>
    </div>
  );
}
