import Link from "next/link";
import type { ProjectSummary } from "@/lib/data/projects";
import { StatusBadge } from "./status-badge";

export function ProjectList({ summaries, emptyMessage }: { summaries: ProjectSummary[]; emptyMessage: string }) {
  if (summaries.length === 0) {
    return (
      <div className="rounded-xl border border-dashed border-zinc-800 p-12 text-center text-zinc-500">
        {emptyMessage}
      </div>
    );
  }

  return (
    <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
      {summaries.map(({ project, video, clipCount, completedClipCount, topScore }) => (
        <Link
          key={project.id}
          href={`/dashboard/projects/${project.id}`}
          className="flex flex-col gap-3 rounded-xl border border-zinc-800 bg-zinc-900/40 p-5 transition hover:border-brand-400/50 hover:bg-zinc-900"
        >
          <div className="flex items-start justify-between gap-2">
            <h3 className="line-clamp-2 font-medium text-white">{project.title}</h3>
            <StatusBadge status={project.status} />
          </div>
          <dl className="mt-auto grid grid-cols-2 gap-2 text-xs text-zinc-500">
            <div>
              <dt>Durata sorgente</dt>
              <dd className="text-zinc-300">
                {video?.duration_seconds ? `${Math.round(video.duration_seconds / 60)} min` : "—"}
              </dd>
            </div>
            <div>
              <dt>Clip</dt>
              <dd className="text-zinc-300">
                {clipCount > 0 ? `${completedClipCount}/${clipCount} renderizzate` : "—"}
              </dd>
            </div>
            <div>
              <dt>Miglior score</dt>
              <dd className="text-zinc-300">{topScore ?? "—"}</dd>
            </div>
            <div>
              <dt>Creato</dt>
              <dd className="text-zinc-300">{new Date(project.created_at).toLocaleDateString("it-IT")}</dd>
            </div>
          </dl>
        </Link>
      ))}
    </div>
  );
}
