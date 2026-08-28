const STATUS_STYLES: Record<string, string> = {
  UPLOADING: "bg-zinc-700/40 text-zinc-300",
  UPLOADED: "bg-zinc-700/40 text-zinc-300",
  DOWNLOADING: "bg-amber-500/15 text-amber-300",
  EXTRACTING_AUDIO: "bg-amber-500/15 text-amber-300",
  TRANSCRIBING: "bg-amber-500/15 text-amber-300",
  ANALYZING: "bg-amber-500/15 text-amber-300",
  CLIP_SELECTION: "bg-amber-500/15 text-amber-300",
  READY: "bg-emerald-500/15 text-emerald-300",
  FAILED: "bg-red-500/15 text-red-300",
  PENDING: "bg-zinc-700/40 text-zinc-300",
  RENDERING: "bg-amber-500/15 text-amber-300",
  COMPLETED: "bg-emerald-500/15 text-emerald-300",
  SUGGESTED: "bg-zinc-700/40 text-zinc-300",
  QUEUED: "bg-zinc-700/40 text-zinc-300",
};

const STATUS_LABELS: Record<string, string> = {
  UPLOADING: "Caricamento",
  UPLOADED: "Caricato",
  DOWNLOADING: "Download in corso",
  EXTRACTING_AUDIO: "Estrazione audio",
  TRANSCRIBING: "Trascrizione",
  ANALYZING: "Analisi AI",
  CLIP_SELECTION: "Selezione clip",
  READY: "Pronto",
  FAILED: "Fallito",
  PENDING: "In coda",
  RENDERING: "Rendering",
  COMPLETED: "Completato",
  SUGGESTED: "Suggerita",
  QUEUED: "In coda",
};

export function StatusBadge({ status }: { status: string }) {
  return (
    <span className={`inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-medium ${STATUS_STYLES[status] ?? "bg-zinc-700/40 text-zinc-300"}`}>
      {STATUS_LABELS[status] ?? status}
    </span>
  );
}

export function isProcessingStatus(status: string): boolean {
  return !["READY", "FAILED"].includes(status);
}
