import { requireUser } from "@/lib/auth";
import { YoutubeConnectionPanel } from "@/components/youtube-connection-panel";
import { FollowedChannelsPanel } from "@/components/followed-channels-panel";
import { FollowedTwitchChannelsPanel } from "@/components/followed-twitch-channels-panel";

// Vedi commento in dashboard/batch/page.tsx: senza questo, su Vercel i dati possono restare
// cachati anche col polling attivo.
export const dynamic = "force-dynamic";

export default async function SettingsPage({
  searchParams,
}: {
  searchParams: { youtube_connected?: string; youtube_error?: string };
}) {
  const { supabase, user } = await requireUser();
  const { data: profile } = await supabase.from("profiles").select("*").eq("id", user.id).single();
  const { data: youtubeConnection } = await supabase
    .from("youtube_connections")
    .select("channel_title")
    .eq("user_id", user.id)
    .maybeSingle();
  const { data: followedChannels } = await supabase
    .from("followed_channels")
    .select("id, channel_title")
    .eq("user_id", user.id)
    .order("created_at", { ascending: true });
  const { data: followedTwitchChannels } = await supabase
    .from("followed_twitch_channels")
    .select("id, display_name")
    .eq("user_id", user.id)
    .order("created_at", { ascending: true });

  return (
    <div className="mx-auto max-w-2xl space-y-6">
      <h1 className="text-2xl font-semibold text-white">Impostazioni</h1>

      {searchParams.youtube_connected && (
        <div className="rounded-lg border border-emerald-500/30 bg-emerald-500/10 p-3 text-sm text-emerald-300">
          Account YouTube collegato con successo.
        </div>
      )}
      {searchParams.youtube_error && (
        <div className="rounded-lg border border-red-500/30 bg-red-500/10 p-3 text-sm text-red-300">
          Connessione YouTube fallita: {searchParams.youtube_error}
        </div>
      )}

      <div className="rounded-xl border border-zinc-800 bg-zinc-900/40 p-5">
        <dl className="space-y-4 text-sm">
          <div className="flex justify-between border-b border-zinc-800 pb-3">
            <dt className="text-zinc-500">Email</dt>
            <dd className="text-zinc-200">{user.email}</dd>
          </div>
          <div className="flex justify-between border-b border-zinc-800 pb-3">
            <dt className="text-zinc-500">Piano attuale</dt>
            <dd className="text-zinc-200">{profile?.plan ?? "FREE"}</dd>
          </div>
          <div className="flex justify-between">
            <dt className="text-zinc-500">Account creato il</dt>
            <dd className="text-zinc-200">
              {profile?.created_at ? new Date(profile.created_at).toLocaleDateString("it-IT") : "—"}
            </dd>
          </div>
        </dl>
      </div>

      <div className="rounded-xl border border-zinc-800 bg-zinc-900/40 p-5">
        <h2 className="mb-3 text-sm font-semibold text-zinc-300">Pubblicazione YouTube</h2>
        <YoutubeConnectionPanel channelTitle={youtubeConnection?.channel_title ?? null} />
      </div>

      {youtubeConnection && (
        <div className="rounded-xl border border-zinc-800 bg-zinc-900/40 p-5">
          <h2 className="mb-1 text-sm font-semibold text-zinc-300">Canali seguiti</h2>
          <p className="mb-3 text-xs text-zinc-500">
            Aggiungi canali YouTube da controllare — lo scan importa da solo i video nuovi nella pipeline normale.
          </p>
          <FollowedChannelsPanel
            channels={(followedChannels ?? []).map((c) => ({ id: c.id, channelTitle: c.channel_title }))}
          />
        </div>
      )}

      <div className="rounded-xl border border-zinc-800 bg-zinc-900/40 p-5">
        <h2 className="mb-1 text-sm font-semibold text-zinc-300">Canali Twitch seguiti (video long-form)</h2>
        <p className="mb-3 text-xs text-zinc-500">
          Nessuna connessione richiesta. I VOD recenti compaiono nella tab Feed — da lì scegli quali trasformare in video
          long-form divisi per argomento.
        </p>
        <FollowedTwitchChannelsPanel
          channels={(followedTwitchChannels ?? []).map((c) => ({ id: c.id, displayName: c.display_name }))}
        />
      </div>

      <p className="text-xs text-zinc-600">
        Gestione fatturazione e upgrade piano non ancora disponibili in questa fase.
      </p>
    </div>
  );
}
