import Link from "next/link";
import { Clapperboard, Film, Radio } from "lucide-react";
import type { ProjectSummary } from "@/lib/data/projects";
import { StatusBadge, isProcessingStatus } from "./status-badge";
import { CancelProjectButton } from "./cancel-project-button";
import { DeleteSourceButton } from "./delete-source-button";
import { ProcessingProgressBar } from "./processing-progress-bar";
import { EmptyState, ScoreRing, formatDuration } from "./ui";

export function ProjectList({ summaries, emptyMessage }: { summaries: ProjectSummary[]; emptyMessage: string }) {
  if (summaries.length === 0) {
    return <EmptyState icon={<Clapperboard size={20} />} title="Niente da mostrare" description={emptyMessage} />;
  }

  return (
    <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-3">
      {summaries.map((summary) => (
        <ProjectCard key={summary.project.id} summary={summary} />
      ))}
    </div>
  );
}

function ProjectCard({ summary }: { summary: ProjectSummary }) {
  const { project, video, clipCount, completedClipCount, topScore, coverUrl } = summary;
  const processing = isProcessingStatus(project.status);
  const isVod = project.source_type === "twitch_vod";

  return (
    <Link
      href={`/dashboard/projects/${project.id}`}
      className="group card card-hover flex flex-col overflow-hidden animate-fade-in hover:-translate-y-0.5 hover:shadow-glow"
    >
      <div className="relative aspect-video overflow-hidden bg-raised">
        {coverUrl ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={coverUrl} alt="" loading="lazy" className="h-full w-full object-cover transition duration-300 group-hover:scale-[1.03]" />
        ) : (
          <div className="flex h-full w-full items-center justify-center bg-[radial-gradient(circle_at_30%_20%,rgba(124,92,255,0.25),transparent_60%),radial-gradient(circle_at_80%_90%,rgba(255,92,168,0.15),transparent_55%)]">
            {isVod ? <Radio size={28} className="text-brand-300/70" /> : <Film size={28} className="text-brand-300/70" />}
          </div>
        )}
        <div className="absolute inset-0 bg-gradient-to-t from-black/70 via-transparent to-black/20" />
        <div className="absolute left-3 top-3 flex items-center gap-1.5">
          <StatusBadge status={project.status} className="bg-black/60 backdrop-blur" />
          {isVod && <span className="rounded-full border border-purple-400/30 bg-purple-500/30 px-2 py-0.5 text-[11px] font-medium text-purple-100 backdrop-blur">VOD Twitch</span>}
        </div>
        {topScore !== null && (
          <div className="absolute right-3 top-3">
            <ScoreRing score={topScore} size={40} />
          </div>
        )}
        {video?.duration_seconds ? (
          <span className="absolute bottom-3 right-3 rounded-md bg-black/70 px-1.5 py-0.5 text-[11px] font-medium text-white backdrop-blur">
            {formatDuration(video.duration_seconds)}
          </span>
        ) : null}
      </div>

      <div className="flex flex-1 flex-col gap-3 p-4">
        <h3 className="line-clamp-2 font-medium leading-snug text-ink">{project.title}</h3>

        {processing ? (
          <ProcessingProgressBar status={project.status} showSteps={false} />
        ) : (
          <p className="text-xs text-muted">
            {clipCount > 0 ? (
              <>
                <span className="font-medium text-ink">{clipCount}</span> clip trovate
                {completedClipCount > 0 && (
                  <>
                    {" · "}
                    <span className="font-medium text-emerald-300">{completedClipCount}</span> pronte
                  </>
                )}
              </>
            ) : (
              "Nessuna clip"
            )}
          </p>
        )}

        <div className="mt-auto flex items-center justify-between gap-2">
          <span className="text-xs text-faint">{new Date(project.created_at).toLocaleDateString("it-IT", { day: "numeric", month: "short" })}</span>
          <div className="flex items-center gap-1.5">
            {processing && <CancelProjectButton projectId={project.id} compact />}
            {video?.storage_path && <DeleteSourceButton projectId={project.id} compact />}
          </div>
        </div>
      </div>
    </Link>
  );
}
