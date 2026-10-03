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

  // Nella pagina del progetto le fasi sono segmenti: quelle fatte piene, quella in corso che si
  // riempie, le prossime spente. Si vede subito a che punto è, senza leggere le etichette.
  if (showSteps) {
    return (
      <ol className="grid grid-cols-6 gap-1.5">
        {STAGES.map((stage, i) => {
          const done = i < currentIndex;
          const current = i === currentIndex;
          return (
            <li key={stage.status} className="space-y-2">
              <div className={`relative h-1.5 overflow-hidden rounded-full ${done ? "bg-brand-400" : current ? "bg-brand-400/25" : "bg-white/[0.08]"}`}>
                {current && <div className="absolute inset-0 animate-shimmer bg-[linear-gradient(90deg,transparent,#ffd400,transparent)] bg-[length:200%_100%]" />}
              </div>
              <p className={`hidden truncate text-[11px] sm:block ${done ? "text-muted" : current ? "font-semibold text-brand-200" : "text-faint"}`}>{stage.label}</p>
            </li>
          );
        })}
      </ol>
    );
  }

  return (
    <div className="h-1.5 w-full overflow-hidden rounded-full bg-white/[0.08]">
      <div className="relative h-full rounded-full bg-brand-gradient transition-all duration-700" style={{ width: `${pct}%` }}>
        <div className="absolute inset-0 animate-shimmer bg-[linear-gradient(90deg,transparent,rgba(255,255,255,0.35),transparent)] bg-[length:200%_100%]" />
      </div>
    </div>
  );
}
