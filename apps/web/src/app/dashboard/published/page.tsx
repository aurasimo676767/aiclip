import { CalendarClock, Eye, ExternalLink, Heart, MessageCircle } from "lucide-react";
import { requireUser } from "@/lib/auth";
import { PollingRefresher } from "@/components/polling-refresher";
import { MarkYoutubeDeletedButton } from "@/components/mark-youtube-deleted-button";
import { EmptyState, PageHeader, Stat, formatDuration } from "@/components/ui";
import { getPresignedDownloadUrl } from "@/lib/storage/r2";

// Vedi commento in dashboard/batch/page.tsx: senza questo, su Vercel i dati possono restare
// cachati anche col polling attivo.
export const dynamic = "force-dynamic";

interface ClipInfo {
  title: string;
  duration: number;
  format: string;
  thumbnail_path: string | null;
}

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
  clips: ClipInfo | ClipInfo[] | null;
}

function clipInfo(row: PublishJobRow): ClipInfo {
  const c = Array.isArray(row.clips) ? row.clips[0] : row.clips;
  return { title: c?.title ?? "Clip", duration: c?.duration ?? 0, format: c?.format ?? "short", thumbnail_path: c?.thumbnail_path ?? null };
}

export default async function PublishedPage() {
  const { supabase } = await requireUser();

  const { data: jobsRaw } = await supabase
    .from("youtube_publish_jobs")
    .select(
      "id, clip_id, status, youtube_url, publish_at, completed_at, view_count, like_count, comment_count, stats_updated_at, cancelled_at, clips(title, duration, format, thumbnail_path)",
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

  // Copertine: URL firmati calcolati in locale, nessuna chiamata a R2.
  const thumbs = new Map<string, string | null>();
  await Promise.all(
    [...scheduled, ...published].map(async (job) => {
      const path = clipInfo(job).thumbnail_path;
      thumbs.set(job.id, path ? await getPresignedDownloadUrl(path, 6 * 3600).catch(() => null) : null);
    }),
  );

  const totalViews = published.reduce((sum, j) => sum + (j.view_count ?? 0), 0);
  const totalLikes = published.reduce((sum, j) => sum + (j.like_count ?? 0), 0);
  const maxViews = Math.max(1, ...published.map((j) => j.view_count ?? 0));

  // Le statistiche vengono aggiornate da un job periodico del worker (ogni ~20 minuti), non
  // in tempo reale ad ogni apertura pagina: qui basta un refresh ogni tot per vederle aggiornare
  // senza dover ricaricare a mano, e per far avanzare i video "programmati" a "pubblicati" da soli.
  const pollingActive = scheduled.length > 0;

  return (
    <div className="mx-auto max-w-5xl space-y-10">
      <PollingRefresher active={pollingActive} intervalMs={60_000} />

      <PageHeader title="Pubblicati" description="Video programmati e già usciti su YouTube. Le statistiche si aggiornano da sole ogni ~20 minuti." />

      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <Stat label="Pubblicati" value={published.length} />
        <Stat label="Programmati" value={scheduled.length} />
        <Stat label="Visualizzazioni" value={formatCompact(totalViews)} />
        <Stat label="Like" value={formatCompact(totalLikes)} />
      </div>

      <section className="space-y-4">
        <h2 className="section-title flex items-center gap-2">
          <CalendarClock size={16} className="text-amber-300" /> In uscita
        </h2>
        {scheduled.length === 0 ? (
          <EmptyState title="Nessun video in programmazione" description="Seleziona delle clip pronte in un progetto e premi Programma." />
        ) : (
          <ul className="card divide-y divide-line">
            {scheduled.map((job) => {
              const info = clipInfo(job);
              return (
                <li key={job.id} className="flex items-center gap-4 p-3">
                  <Thumb url={thumbs.get(job.id) ?? null} format={info.format} />
                  <div className="min-w-0 flex-1">
                    <p className="line-clamp-2 text-sm font-medium text-ink">{info.title}</p>
                    <p className="mt-1 text-xs text-amber-200">
                      {new Date(job.publish_at!).toLocaleString("it-IT", { weekday: "short", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" })}
                    </p>
                  </div>
                  <MarkYoutubeDeletedButton clipId={job.clip_id} />
                </li>
              );
            })}
          </ul>
        )}
      </section>

      <section className="space-y-4">
        <h2 className="section-title">Già online</h2>
        {published.length === 0 ? (
          <EmptyState title="Nessun video pubblicato ancora" />
        ) : (
          <ul className="card divide-y divide-line">
            {published.map((job) => {
              const info = clipInfo(job);
              return (
                <li key={job.id} className="flex items-center gap-4 p-3">
                  <Thumb url={thumbs.get(job.id) ?? null} format={info.format} />
                  <div className="min-w-0 flex-1 space-y-1.5">
                    <a href={job.youtube_url!} target="_blank" rel="noreferrer" className="group inline-flex items-start gap-1.5 text-sm font-medium text-ink hover:text-brand-200">
                      <span className="line-clamp-2">{info.title}</span>
                      <ExternalLink size={13} className="mt-0.5 shrink-0 text-faint group-hover:text-brand-300" />
                    </a>
                    <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted">
                      <span className="inline-flex items-center gap-1">
                        <Eye size={12} /> <span className="font-medium text-ink">{formatCount(job.view_count)}</span>
                      </span>
                      <span className="inline-flex items-center gap-1">
                        <Heart size={12} /> {formatCount(job.like_count)}
                      </span>
                      <span className="inline-flex items-center gap-1">
                        <MessageCircle size={12} /> {formatCount(job.comment_count)}
                      </span>
                      <span className="text-faint">
                        {formatDuration(info.duration)}
                        {job.completed_at ? ` · ${new Date(job.completed_at).toLocaleDateString("it-IT", { day: "numeric", month: "short" })}` : ""}
                      </span>
                    </div>
                    <div className="h-1 max-w-xs overflow-hidden rounded-full bg-overlay">
                      <div className="h-full rounded-full bg-brand-gradient" style={{ width: `${((job.view_count ?? 0) / maxViews) * 100}%` }} />
                    </div>
                  </div>
                  <MarkYoutubeDeletedButton clipId={job.clip_id} />
                </li>
              );
            })}
          </ul>
        )}
      </section>
    </div>
  );
}

function Thumb({ url, format }: { url: string | null; format: string }) {
  const shape = format === "longform" ? "aspect-video w-24" : "aspect-[9/16] w-11";
  return (
    <div className={`${shape} shrink-0 overflow-hidden rounded-lg border border-line bg-raised`}>
      {/* eslint-disable-next-line @next/next/no-img-element */}
      {url && <img src={url} alt="" loading="lazy" className="h-full w-full object-cover" />}
    </div>
  );
}

function formatCount(value: number | null): string {
  if (value === null) return "—";
  return new Intl.NumberFormat("it-IT").format(value);
}

function formatCompact(value: number): string {
  return new Intl.NumberFormat("it-IT", { notation: "compact", maximumFractionDigits: 1 }).format(value);
}
