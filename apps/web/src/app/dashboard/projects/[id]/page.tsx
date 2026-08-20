import { notFound } from "next/navigation";
import type { ClipScores } from "@clipforge/shared";
import { requireUser } from "@/lib/auth";
import { StatusBadge, isProcessingStatus } from "@/components/status-badge";
import { PollingRefresher } from "@/components/polling-refresher";
import { ClipList, type ClipViewModel } from "@/components/clip-list";

export default async function ProjectDetailPage({ params }: { params: { id: string } }) {
  const { supabase } = await requireUser();

  const { data: project } = await supabase.from("projects").select("*").eq("id", params.id).single();
  if (!project) {
    notFound();
  }

  const { data: video } = await supabase.from("videos").select("*").eq("project_id", params.id).maybeSingle();
  const { data: clipsRaw } = await supabase
    .from("clips")
    .select("id, title, hook, reason, duration, scores, status, error_message")
    .eq("project_id", params.id);

  const clips: ClipViewModel[] = (clipsRaw ?? []).map((c) => ({
    id: c.id,
    title: c.title,
    hook: c.hook,
    reason: c.reason,
    duration: c.duration,
    scores: c.scores as ClipScores,
    status: c.status,
    errorMessage: c.error_message,
  }));

  const projectProcessing = isProcessingStatus(project.status);
  const anyClipInFlight = clips.some((c) => c.status === "QUEUED" || c.status === "RENDERING");
  const pollingActive = projectProcessing || anyClipInFlight;

  return (
    <div className="mx-auto max-w-4xl space-y-6">
      <PollingRefresher active={pollingActive} />

      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold text-white">{project.title}</h1>
          {video && (
            <p className="mt-1 text-sm text-zinc-500">
              {video.original_filename}
              {video.duration_seconds ? ` — ${Math.round(video.duration_seconds / 60)} min` : ""}
            </p>
          )}
        </div>
        <StatusBadge status={project.status} />
      </div>

      {project.status === "FAILED" && (
        <div className="rounded-lg border border-red-500/30 bg-red-500/10 p-4 text-sm text-red-300">
          Elaborazione fallita: {project.error_message ?? video?.error_message ?? "errore sconosciuto"}
        </div>
      )}

      {projectProcessing && clips.length === 0 && (
        <div className="flex items-center gap-3 rounded-xl border border-zinc-800 bg-zinc-900/40 p-8">
          <span className="h-2.5 w-2.5 animate-pulse rounded-full bg-brand-400" />
          <p className="text-zinc-300">
            {statusMessage(project.status)}
          </p>
        </div>
      )}

      {clips.length > 0 && (
        <div className="space-y-4">
          <p className="text-sm text-zinc-400">Trovate {clips.length} clip potenziali</p>
          <ClipList clips={clips} />
        </div>
      )}
    </div>
  );
}

function statusMessage(status: string): string {
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
