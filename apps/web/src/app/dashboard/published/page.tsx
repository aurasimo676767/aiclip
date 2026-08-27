import { requireUser } from "@/lib/auth";
import { PollingRefresher } from "@/components/polling-refresher";
import { MarkYoutubeDeletedButton } from "@/components/mark-youtube-deleted-button";

// Vedi commento in dashboard/batch/page.tsx: senza questo, su Vercel i dati possono restare
// cachati anche col polling attivo.
export const dynamic = "force-dynamic";

interface PublishJobRow {
  id: string;
  clip_id: string;
  status: string;
  youtube_url: string | null;
  publish_at: string | null;
  completed_at: string | null;
  view_count: number | null;
  like_count: number | null;
  comment_count: number | null;
  stats_updated_at: string | null;
  cancelled_at: string | null;
  clips: { title: string; duration: number } | { title: string; duration: number }[] | null;
}

function clipInfo(row: PublishJobRow): { title: string; duration: number } {
  const c = Array.isArray(row.clips) ? row.clips[0] : row.clips;
  return { title: c?.title ?? "Clip", duration: c?.duration ?? 0 };
}

export default async function PublishedPage() {
  const { supabase } = await requireUser();

  const { data: jobsRaw } = await supabase
    .from("youtube_publish_jobs")
    .select(
      "id, clip_id, status, youtube_url, publish_at, completed_at, view_count, like_count, comment_count, stats_updated_at, cancelled_at, clips(title, duration)",
    )
    .order("created_at", { ascending: false });

  const jobs = (jobsRaw ?? []) as unknown as PublishJobRow[];
  const now = Date.now();

  const scheduled = jobs
    .filter((j) => !j.cancelled_at && j.publish_at && new Date(j.publish_at).getTime() > now)
    .sort((a, b) => new Date(a.publish_at!).getTime() - new Date(b.publish_at!).getTime());

  const published = jobs
    .filter((j) => !j.cancelled_at && j.status === "COMPLETED" && j.youtube_url && (!j.publish_at || new Date(j.publish_at).getTime() <= now))
    .sort((a, b) => new Date(b.completed_at ?? b.publish_at ?? 0).getTime() - new Date(a.completed_at ?? a.publish_at ?? 0).getTime());

  // Le statistiche vengono aggiornate da un job periodico del worker (ogni ~20 minuti), non
  // in tempo reale ad ogni apertura pagina: qui basta un refresh ogni tot per vederle aggiornare
  // senza dover ricaricare a mano, e per far avanzare i video "programmati" a "pubblicati" da soli.
  const pollingActive = scheduled.length > 0;

  return (
    <div className="mx-auto max-w-4xl space-y-8">
      <PollingRefresher active={pollingActive} intervalMs={60_000} />

      <div>
        <h1 className="text-2xl font-semibold text-white">Pubblicati</h1>
        <p className="mt-1 text-sm text-zinc-500">
          Video programmati e già usciti su YouTube. Le statistiche si aggiornano da sole ogni ~20 minuti.
        </p>
      </div>

      <section className="space-y-3">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-zinc-500">Programmati ({scheduled.length})</h2>
        {scheduled.length === 0 ? (
          <p className="text-sm text-zinc-600">Nessun video in programmazione al momento.</p>
        ) : (
          <ul className="space-y-2">
            {scheduled.map((job) => {
              const { title } = clipInfo(job);
              return (
                <li
                  key={job.id}
                  className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-zinc-800 bg-zinc-900/40 p-3"
                >
                  <span className="min-w-0 break-words text-sm text-white">{title}</span>
                  <div className="flex shrink-0 items-center gap-2">
                    <span className="rounded-full bg-amber-500/15 px-2.5 py-0.5 text-xs font-medium text-amber-300">
                      {new Date(job.publish_at!).toLocaleString("it-IT", { dateStyle: "medium", timeStyle: "short" })}
                    </span>
                    <MarkYoutubeDeletedButton clipId={job.clip_id} />
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </section>

      <section className="space-y-3">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-zinc-500">Pubblicati ({published.length})</h2>
        {published.length === 0 ? (
          <p className="text-sm text-zinc-600">Nessun video pubblicato ancora.</p>
        ) : (
          <ul className="space-y-2">
            {published.map((job) => {
              const { title, duration } = clipInfo(job);
              return (
                <li key={job.id} className="rounded-lg border border-zinc-800 bg-zinc-900/40 p-3">
                  <div className="flex flex-wrap items-start justify-between gap-2">
                    <a
                      href={job.youtube_url!}
                      target="_blank"
                      rel="noreferrer"
                      className="min-w-0 break-words text-sm font-medium text-white hover:underline"
                    >
                      {title} ↗
                    </a>
                    <span className="shrink-0 text-xs text-zinc-500">
                      {job.completed_at
                        ? new Date(job.completed_at).toLocaleDateString("it-IT", { dateStyle: "medium" })
                        : ""}
                    </span>
                  </div>
                  <div className="mt-1 flex flex-wrap items-center justify-between gap-2">
                    <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-zinc-400">
                      <span>{Math.round(duration)}s</span>
                      <span>{formatCount(job.view_count)} visualizzazioni</span>
                      <span>{formatCount(job.like_count)} like</span>
                      <span>{formatCount(job.comment_count)} commenti</span>
                    </div>
                    <MarkYoutubeDeletedButton clipId={job.clip_id} />
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </section>
    </div>
  );
}

function formatCount(value: number | null): string {
  if (value === null) return "—";
  return new Intl.NumberFormat("it-IT").format(value);
}
