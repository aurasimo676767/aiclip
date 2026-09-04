import type { ModelUsageKey, VideoUsageStats } from "@clipforge/shared";

const MODEL_LABELS: Record<ModelUsageKey, string> = {
  haiku: "Haiku",
  sonnet: "Sonnet",
  opus: "Opus",
};

function formatDuration(seconds: number | undefined): string | null {
  if (seconds === undefined) return null;
  if (seconds < 60) return `${Math.round(seconds)}s`;
  const minutes = Math.floor(seconds / 60);
  const rest = Math.round(seconds % 60);
  return `${minutes}m ${rest}s`;
}

function formatTokens(n: number): string {
  return n.toLocaleString("it-IT");
}

/**
 * Pannello con costo/token/tempi REALI (non stimati) di elaborazione di questo video — letti da
 * videos.usage_stats, popolato dal worker a fine pipeline (vedi process-video-job.ts). Nato per
 * confrontare una previsione di costo col consumo vero su un VOD lungo. Per ora popolato solo
 * dalla pipeline long-form: su uno Short i token/costo restano assenti, si vedono solo le fasi.
 */
export function UsageStatsPanel({ stats }: { stats: VideoUsageStats }) {
  const modelEntries = Object.entries(stats.tokens) as [ModelUsageKey, { input: number; output: number; calls: number }][];
  const stageEntries: Array<[string, string | null]> = [
    ["Download", formatDuration(stats.stages.downloadSeconds)],
    ["Trascrizione", formatDuration(stats.stages.transcriptionSeconds)],
    ["Analisi AI", formatDuration(stats.stages.aiAnalysisSeconds)],
  ];
  const visibleStages = stageEntries.filter(([, value]) => value !== null);

  if (modelEntries.length === 0 && visibleStages.length === 0) return null;

  return (
    <div className="rounded-xl border border-zinc-800 bg-zinc-900/40 p-4 text-sm">
      <p className="mb-3 font-medium text-zinc-300">Uso AI e tempi per questo video</p>

      {modelEntries.length > 0 && (
        <div className="mb-3 space-y-1.5">
          {modelEntries.map(([model, usage]) => {
            const cost = stats.costUsd[model];
            return (
              <div key={model} className="flex items-center justify-between gap-3 text-zinc-400">
                <span>
                  <span className="font-medium text-zinc-300">{MODEL_LABELS[model]}:</span> {formatTokens(usage.input)} input /{" "}
                  {formatTokens(usage.output)} output
                  <span className="text-zinc-600"> ({usage.calls} {usage.calls === 1 ? "chiamata" : "chiamate"})</span>
                </span>
                {cost !== undefined && <span className="shrink-0 tabular-nums text-zinc-300">${cost.toFixed(3)}</span>}
              </div>
            );
          })}
          <div className="flex items-center justify-between gap-3 border-t border-zinc-800 pt-1.5 font-medium text-zinc-300">
            <span>Totale</span>
            <span className="tabular-nums">${stats.costUsd.total.toFixed(3)}</span>
          </div>
        </div>
      )}

      {visibleStages.length > 0 && (
        <div className={`flex flex-wrap gap-x-4 gap-y-1 text-zinc-500 ${modelEntries.length > 0 ? "border-t border-zinc-800 pt-3" : ""}`}>
          {visibleStages.map(([label, value]) => (
            <span key={label}>
              {label}: <span className="text-zinc-300">{value}</span>
            </span>
          ))}
        </div>
      )}
    </div>
  );
}
