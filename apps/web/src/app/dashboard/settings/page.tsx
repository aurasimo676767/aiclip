import { requireUser } from "@/lib/auth";
import { YoutubeConnectionPanel } from "@/components/youtube-connection-panel";

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

      <p className="text-xs text-zinc-600">
        Gestione fatturazione e upgrade piano non ancora disponibili in questa fase.
      </p>
    </div>
  );
}
