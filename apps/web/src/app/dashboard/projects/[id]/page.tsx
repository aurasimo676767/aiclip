import { notFound } from "next/navigation";
import { requireUser } from "@/lib/auth";
import { StatusBadge, isProcessingStatus } from "@/components/status-badge";
import { PollingRefresher } from "@/components/polling-refresher";
import { ClipList } from "@/components/clip-list";
import { RetryProjectButton } from "@/components/retry-project-button";
import { CancelProjectButton } from "@/components/cancel-project-button";
import { fetchProjectDetails, fetchYoutubeConnected } from "@/lib/data/clips";

// Vedi commento in dashboard/batch/page.tsx: senza questo, su Vercel i dati possono restare
// cachati anche col polling attivo.
export const dynamic = "force-dynamic";

export default async function ProjectDetailPage({ params }: { params: { id: string } }) {
  const { supabase, user } = await requireUser();

  const [details, youtubeConnected] = await Promise.all([
    fetchProjectDetails(supabase, [params.id]),
    fetchYoutubeConnected(supabase, user.id),
  ]);
  const detail = details.get(params.id);
  if (!detail) {
    notFound();
  }
  const { project, video, clips } = detail;

  const projectProcessing = isProcessingStatus(project.status);
  const anyClipInFlight = clips.some((c) => c.status === "QUEUED" || c.status === "RENDERING");
  const anyPublishInFlight = clips.some((c) => c.youtubePublishStatus === "PENDING" || c.youtubePublishStatus === "UPLOADING");
  const pollingActive = projectProcessing || anyClipInFlight || anyPublishInFlight;

  return (
    <div className="mx-auto max-w-4xl space-y-6">
      <PollingRefresher active={pollingActive} />

      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="min-w-0">
          <h1 className="text-2xl font-semibold text-white break-words">{project.title}</h1>
          {video && (
            <p className="mt-1 text-sm text-zinc-500 break-words">
              {video.original_filename}
              {video.duration_seconds ? ` — ${Math.round(video.duration_seconds / 60)} min` : ""}
            </p>
          )}
        </div>
        <StatusBadge status={project.status} />
      </div>

      {project.status === "FAILED" && (
        <div className="rounded-lg border border-red-500/30 bg-red-500/10 p-4 text-sm text-red-300">
          <p>Elaborazione fallita: {project.error_message ?? video?.error_message ?? "errore sconosciuto"}</p>
          <RetryProjectButton projectId={project.id} />
        </div>
      )}

      {projectProcessing && clips.length === 0 && (
        <div className="flex items-center justify-between gap-3 rounded-xl border border-zinc-800 bg-zinc-900/40 p-8">
          <div className="flex items-center gap-3">
            <span className="h-2.5 w-2.5 animate-pulse rounded-full bg-brand-400" />
            <p className="text-zinc-300">{statusMessage(project.status)}</p>
          </div>
          <CancelProjectButton projectId={project.id} compact />
        </div>
      )}

      {clips.length > 0 && (
        <div className="space-y-4">
          <p className="text-sm text-zinc-400">Trovate {clips.length} clip potenziali</p>
          <ClipList clips={clips} youtubeConnected={youtubeConnected} />
        </div>
      )}
    </div>
  );
}

export function statusMessage(status: string): string {
  switch (status) {
    case "UPLOADING":
    case "UPLOADED":
      return "In attesa che il worker prenda in carico il video...";
    case "DOWNLOADING":
      return "Download del video da YouTube in corso...";
    case "EXTRACTING_AUDIO":
      return "Estrazione audio in corso...";
    case "TRANSCRIBING":
      return "Trascrizione in corso...";
    case "ANALYZING":
      return "Analisi del contenuto con l'AI...";
    case "CLIP_SELECTION":
      return "Selezione delle clip migliori...";
    default:
      return "Elaborazione in corso...";
  }
}
