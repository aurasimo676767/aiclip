import Link from "next/link";
import { ArrowUpRight, Radio, Tv } from "lucide-react";
import { requireUser } from "@/lib/auth";
import { VideoFeed } from "@/components/video-feed";
import { TwitchVideoFeed } from "@/components/twitch-video-feed";
import { EmptyState, PageHeader } from "@/components/ui";

export default async function FeedPage() {
  const { supabase, user } = await requireUser();

  const { data: connection } = await supabase.from("youtube_connections").select("channel_title").eq("user_id", user.id).maybeSingle();
  const { data: channels } = await supabase.from("followed_channels").select("id, channel_title").eq("user_id", user.id);
  const { data: twitchChannels } = await supabase.from("followed_twitch_channels").select("id, display_name").eq("user_id", user.id);

  const settingsLink = (
    <Link href="/dashboard/settings" className="btn btn-secondary btn-sm">
      Vai alle Opzioni
    </Link>
  );

  return (
    <div className="mx-auto max-w-6xl space-y-12">
      <PageHeader title="Feed" description="Gli ultimi video dei canali che segui: premi Genera su quello che vuoi trasformare." />

      <section className="space-y-5">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-3">
            <span className="flex h-9 w-9 items-center justify-center rounded-xl bg-purple-500/15 text-purple-300">
              <Radio size={18} />
            </span>
            <div>
              <h2 className="font-display text-lg font-semibold text-ink">Twitch</h2>
              <p className="text-xs text-muted">VOD → video long-form</p>
            </div>
          </div>
          {twitchChannels && twitchChannels.length > 0 && (
            <div className="flex flex-wrap gap-1.5">
              {twitchChannels.map((c) => (
                <Link key={c.id} href={`/dashboard/feed/twitch/${c.id}`} className="chip transition hover:border-purple-400/50 hover:text-ink">
                  {c.display_name} <ArrowUpRight size={12} />
                </Link>
              ))}
            </div>
          )}
        </div>
        {!twitchChannels || twitchChannels.length === 0 ? (
          <EmptyState title="Non segui ancora nessun canale Twitch" description="Aggiungine uno dalle Opzioni (non serve nessuna connessione)." action={settingsLink} />
        ) : (
          <TwitchVideoFeed />
        )}
      </section>

      <section className="space-y-5">
        <div className="flex items-center gap-3">
          <span className="flex h-9 w-9 items-center justify-center rounded-xl bg-red-500/15 text-red-300">
            <Tv size={18} />
          </span>
          <div>
            <h2 className="font-display text-lg font-semibold text-ink">YouTube</h2>
            <p className="text-xs text-muted">Video → Shorts verticali</p>
          </div>
        </div>
        {!connection ? (
          <EmptyState title="Collega prima un account YouTube" description="Serve per leggere i video dei canali che segui." action={settingsLink} />
        ) : !channels || channels.length === 0 ? (
          <EmptyState title="Non segui ancora nessun canale YouTube" description="Aggiungine uno dalle Opzioni." action={settingsLink} />
        ) : (
          <VideoFeed />
        )}
      </section>
    </div>
  );
}
