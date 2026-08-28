import { requireUser } from "@/lib/auth";
import { PollingRefresher } from "@/components/polling-refresher";
import { ThumbnailGeneratorForm } from "@/components/thumbnail-generator-form";
import { ThumbnailJobCard, type ThumbnailJobViewModel } from "@/components/thumbnail-job-card";

export const dynamic = "force-dynamic";

interface ThumbnailJobRow {
  id: string;
  status: string;
  error_message: string | null;
  youtube_thumbnail_set: boolean;
  created_at: string;
  clips: { title: string } | { title: string }[] | null;
}

function clipTitle(row: ThumbnailJobRow): string {
  const c = Array.isArray(row.clips) ? row.clips[0] : row.clips;
  return c?.title ?? "Clip";
}

export default async function ThumbnailsPage() {
  const { supabase } = await requireUser();

  const { data: jobsRaw } = await supabase
    .from("thumbnail_jobs")
    .select("id, status, error_message, youtube_thumbnail_set, created_at, clips(title)")
    .order("created_at", { ascending: false })
    .limit(30);

  const jobs = (jobsRaw ?? []) as unknown as ThumbnailJobRow[];
  const viewModels: ThumbnailJobViewModel[] = jobs.map((j) => ({
    id: j.id,
    clipTitle: clipTitle(j),
    status: j.status,
    errorMessage: j.error_message,
    youtubeThumbnailSet: j.youtube_thumbnail_set,
    createdAt: j.created_at,
  }));

  const pollingActive = viewModels.some((j) => j.status === "PENDING" || j.status === "PROCESSING");

  return (
    <div className="mx-auto max-w-3xl space-y-8">
      <PollingRefresher active={pollingActive} intervalMs={5000} />

      <div>
        <h1 className="text-2xl font-semibold text-white">Copertine</h1>
        <p className="mt-1 text-sm text-zinc-500">
          Incolla il link di un video long-form già pubblicato da ClipForge: viene generata una copertina automaticamente
          (sfondo dal video, faccia ritagliata se c&apos;è la webcam, titolo ad effetto) e impostata subito su YouTube.
        </p>
      </div>

      <ThumbnailGeneratorForm />

      <section className="space-y-3">
        {viewModels.length === 0 ? (
          <p className="text-sm text-zinc-600">Nessuna copertina generata ancora.</p>
        ) : (
          <ul className="space-y-3">
            {viewModels.map((job) => (
              <ThumbnailJobCard key={job.id} job={job} />
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
