import { Coins, Timer } from "lucide-react";
import type { ModelUsageKey, VideoUsageStats } from "@clipforge/shared";

const MODEL_LABELS: Record<ModelUsageKey, string> = {
  haiku: "Haiku",
  sonnet: "Sonnet",
  opus: "Opus",
};

function formatSeconds(seconds: number | undefined): string | null {
  if (seconds === undefined) return null;
  if (seconds < 60) return `${Math.round(seconds)}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes >= 60) return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
  return `${minutes}m ${Math.round(seconds % 60)}s`;
}

/**
 * Costo/token/tempi REALI (non stimati) di elaborazione di questo video — letti da
 * videos.usage_stats, popolato dal worker a fine pipeline (vedi process-video-job.ts). Per ora i
 * token/costo li popola solo la pipeline long-form: su uno Short si vedono solo le fasi.
 */
export function UsageStatsPanel({ stats }: { stats: VideoUsageStats }) {
  const modelEntries = Object.entries(stats.tokens) as [ModelUsageKey, { input: number; output: number; calls: number }][];
  const stages = (
    [
      ["Download", formatSeconds(stats.stages.downloadSeconds)],
      ["Trascrizione", formatSeconds(stats.stages.transcriptionSeconds)],
      ["Analisi AI", formatSeconds(stats.stages.aiAnalysisSeconds)],
    ] as Array<[string, string | null]>
  ).filter(([, value]) => value !== null);

  if (modelEntries.length === 0 && stages.length === 0) return null;

  return (
    <details className="card group p-4 text-sm">
      <summary className="flex cursor-pointer list-none items-center justify-between gap-3 text-muted">
        <span className="flex flex-wrap items-center gap-x-4 gap-y-1">
          {modelEntries.length > 0 && (
            <span className="inline-flex items-center gap-1.5">
              <Coins size={14} className="text-faint" /> Costo AI <span className="font-medium tabular-nums text-ink">${stats.costUsd.total.toFixed(3)}</span>
            </span>
          )}
          {stages.map(([label, value]) => (
            <span key={label} className="inline-flex items-center gap-1.5">
              <Timer size={14} className="text-faint" /> {label} <span className="font-medium text-ink">{value}</span>
            </span>
          ))}
        </span>
        {modelEntries.length > 0 && <span className="text-xs text-faint group-open:hidden">Dettagli</span>}
      </summary>

      {modelEntries.length > 0 && (
        <div className="mt-4 space-y-1.5 border-t border-line pt-3">
          {modelEntries.map(([model, usage]) => (
            <div key={model} className="flex items-center justify-between gap-3 text-xs text-muted">
              <span>
                <span className="font-medium text-ink">{MODEL_LABELS[model]}</span> · {usage.input.toLocaleString("it-IT")} token in / {usage.output.toLocaleString("it-IT")} out ·{" "}
                {usage.calls} {usage.calls === 1 ? "chiamata" : "chiamate"}
              </span>
              {stats.costUsd[model] !== undefined && <span className="shrink-0 tabular-nums text-ink">${stats.costUsd[model]!.toFixed(3)}</span>}
            </div>
          ))}
        </div>
      )}
    </details>
  );
}
