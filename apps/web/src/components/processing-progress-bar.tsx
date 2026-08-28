// Stima approssimativa "per fase" (non basata sul tempo reale trascorso): ogni stato della
// pipeline è mappato a una percentuale fissa. Utile per farsi un'idea di quanto manca, non un
// conteggio preciso — soprattutto sui VOD Twitch (anche ore di durata) dove il tempo reale di
// ogni fase varia molto più che sui video brevi.
const STAGE_PROGRESS: Record<string, number> = {
  UPLOADING: 5,
  UPLOADED: 8,
  DOWNLOADING: 18,
  EXTRACTING_AUDIO: 28,
  TRANSCRIBING: 55,
  ANALYZING: 85,
  CLIP_SELECTION: 95,
  READY: 100,
};

export function ProcessingProgressBar({ status }: { status: string }) {
  const pct = STAGE_PROGRESS[status] ?? 10;
  return (
    <div className="space-y-1">
      <div className="h-1.5 w-full overflow-hidden rounded-full bg-zinc-800">
        <div className="h-full rounded-full bg-brand-500 transition-all duration-700" style={{ width: `${pct}%` }} />
      </div>
      <p className="text-[11px] text-zinc-600">Stima approssimativa per fase, non un conteggio esatto.</p>
    </div>
  );
}
