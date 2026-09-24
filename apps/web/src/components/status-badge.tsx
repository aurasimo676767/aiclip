type Tone = "neutral" | "working" | "success" | "error";

const TONE_STYLES: Record<Tone, { badge: string; dot: string }> = {
  neutral: { badge: "border-line-strong bg-raised text-muted", dot: "bg-faint" },
  working: { badge: "border-amber-400/30 bg-amber-400/10 text-amber-200", dot: "bg-amber-400 animate-pulse" },
  success: { badge: "border-emerald-400/30 bg-emerald-400/10 text-emerald-200", dot: "bg-emerald-400" },
  error: { badge: "border-red-400/30 bg-red-400/10 text-red-200", dot: "bg-red-400" },
};

const STATUS: Record<string, { label: string; tone: Tone }> = {
  UPLOADING: { label: "Caricamento", tone: "working" },
  UPLOADED: { label: "In attesa", tone: "neutral" },
  DOWNLOADING: { label: "Download", tone: "working" },
  EXTRACTING_AUDIO: { label: "Estrazione audio", tone: "working" },
  TRANSCRIBING: { label: "Trascrizione", tone: "working" },
  ANALYZING: { label: "Analisi AI", tone: "working" },
  CLIP_SELECTION: { label: "Selezione clip", tone: "working" },
  READY: { label: "Pronto", tone: "success" },
  FAILED: { label: "Fallito", tone: "error" },
  PENDING: { label: "In coda", tone: "neutral" },
  RENDERING: { label: "Rendering", tone: "working" },
  COMPLETED: { label: "Pronta", tone: "success" },
  SUGGESTED: { label: "Suggerita", tone: "neutral" },
  QUEUED: { label: "In coda", tone: "neutral" },
};

export function StatusBadge({ status, className = "" }: { status: string; className?: string }) {
  const entry = STATUS[status] ?? { label: status, tone: "neutral" as Tone };
  const style = TONE_STYLES[entry.tone];
  return (
    <span className={`inline-flex shrink-0 items-center gap-1.5 rounded-full border px-2 py-0.5 text-[11px] font-medium ${style.badge} ${className}`}>
      <span className={`h-1.5 w-1.5 rounded-full ${style.dot}`} />
      {entry.label}
    </span>
  );
}

export function isProcessingStatus(status: string): boolean {
  return !["READY", "FAILED"].includes(status);
}
