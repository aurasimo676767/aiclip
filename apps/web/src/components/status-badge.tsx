type Tone = "neutral" | "working" | "success" | "error";

// Solo i colori del sito: giallo = sta lavorando, bianco = fatto, rosso urla = errore. Il verde e
// l'ambra di prima erano altri due accenti in una pagina che ne ha già uno.
const TONE_STYLES: Record<Tone, { badge: string; dot: string }> = {
  neutral: { badge: "border-white/10 bg-black/40 text-muted", dot: "bg-faint" },
  working: { badge: "border-brand-400/30 bg-brand-400/10 text-brand-200", dot: "bg-brand-400 animate-live-pulse" },
  success: { badge: "border-white/15 bg-black/40 text-ink", dot: "bg-ink" },
  error: { badge: "border-hot/50 bg-hot/15 text-red-100", dot: "bg-hot" },
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
