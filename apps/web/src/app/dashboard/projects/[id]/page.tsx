import { notFound } from "next/navigation";
import type { ClipScores } from "@clipforge/shared";
import { requireUser } from "@/lib/auth";
import { StatusBadge, isProcessingStatus } from "@/components/status-badge";
import { PollingRefresher } from "@/components/polling-refresher";
import { ClipList, type ClipViewModel } from "@/components/clip-list";

export default async function ProjectDetailPage({ params }: { params: { id: string } }) {
  const { supabase, user } = await requireUser();

  const { data: project } = await supabase.from("projects").select("*").eq("id", params.id).single();
  if (!project) {
    notFound();
  }

  const { data: video } = await supabase.from("videos").select("*").eq("project_id", params.id).maybeSingle();
  const { data: clipsRaw } = await supabase
    .from("clips")
    .select("id, title, hook, reason, duration, scores, status, error_message, hashtags, caption")
    .eq("project_id", params.id);

  const clipIds = (clipsRaw ?? []).map((c) => c.id);

  const [{ data: youtubeConnection }, { data: publishJobsRaw }] = await Promise.all([
    supabase.from("youtube_connections").select("channel_title").eq("user_id", user.id).maybeSingle(),
    clipIds.length > 0
      ? supabase
          .from("youtube_publish_jobs")
          .select("clip_id, status, youtube_url, error_message, created_at")
          .in("clip_id", clipIds)
          .order("created_at", { ascending: false })
      : Promise.resolve({ data: [] as never[] }),
  ]);

  // Solo il job di pubblicazione più recente per clip (l'array è già ordinato created_at desc).
  const latestPublishByClip = new Map<string, { status: string; youtubeUrl: string | null; errorMessage: string | null }>();
  for (const job of publishJobsRaw ?? []) {
    if (!latestPublishByClip.has(job.clip_id)) {
      latestPublishByClip.set(job.clip_id, { status: job.status, youtubeUrl: job.youtube_url, errorMessage: job.error_message });
    }
  }

  const clips: ClipViewModel[] = (clipsRaw ?? []).map((c) => {
    const publish = latestPublishByClip.get(c.id);
    return {
      id: c.id,
      title: c.title,
      hook: c.hook,
      reason: c.reason,
      duration: c.duration,
      scores: c.scores as ClipScores,
      status: c.status,
      errorMessage: c.error_message,
      hashtags: (c.hashtags as string[] | null) ?? [],
      caption: c.caption ?? "",
      youtubePublishStatus: publish?.status ?? null,
      youtubeUrl: publish?.youtubeUrl ?? null,
      youtubeError: publish?.errorMessage ?? null,
    };
  });

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
          <ClipList clips={clips} youtubeConnected={Boolean(youtubeConnection)} />
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
