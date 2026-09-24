// Stima approssimativa "per fase" (non basata sul tempo reale trascorso): ogni stato della
// pipeline è mappato a una percentuale fissa. Utile per farsi un'idea di quanto manca, non un
// conteggio preciso — soprattutto sui VOD Twitch (anche ore di durata) dove il tempo reale di
// ogni fase varia molto più che sui video brevi.
const STAGES: Array<{ status: string; label: string; pct: number }> = [
  { status: "UPLOADED", label: "In coda", pct: 8 },
  { status: "DOWNLOADING", label: "Download", pct: 18 },
  { status: "EXTRACTING_AUDIO", label: "Audio", pct: 28 },
  { status: "TRANSCRIBING", label: "Trascrizione", pct: 55 },
  { status: "ANALYZING", label: "Analisi AI", pct: 85 },
  { status: "CLIP_SELECTION", label: "Selezione", pct: 95 },
];

const PCT: Record<string, number> = { UPLOADING: 5, READY: 100, ...Object.fromEntries(STAGES.map((s) => [s.status, s.pct])) };

export function ProcessingProgressBar({ status, showSteps = true }: { status: string; showSteps?: boolean }) {
  const pct = PCT[status] ?? 10;
  const currentIndex = STAGES.findIndex((s) => s.status === status);
  return (
    <div className="space-y-2.5">
      <div className="h-1.5 w-full overflow-hidden rounded-full bg-raised">
        <div className="relative h-full rounded-full bg-brand-gradient transition-all duration-700" style={{ width: `${pct}%` }}>
          <div className="absolute inset-0 animate-shimmer bg-[linear-gradient(90deg,transparent,rgba(255,255,255,0.35),transparent)] bg-[length:200%_100%]" />
        </div>
      </div>
      {showSteps && (
        <ol className="hidden grid-cols-6 gap-1 text-[11px] sm:grid">
          {STAGES.map((stage, i) => (
            <li key={stage.status} className={i < currentIndex ? "text-muted" : i === currentIndex ? "font-medium text-ink" : "text-faint"}>
              {stage.label}
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}
