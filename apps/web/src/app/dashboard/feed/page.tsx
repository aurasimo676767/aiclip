import Link from "next/link";
import { requireUser } from "@/lib/auth";
import { VideoFeed } from "@/components/video-feed";

export default async function FeedPage() {
  const { supabase, user } = await requireUser();

  const { data: connection } = await supabase.from("youtube_connections").select("channel_title").eq("user_id", user.id).maybeSingle();
  const { data: channels } = await supabase.from("followed_channels").select("id, channel_title").eq("user_id", user.id);

  return (
    <div className="mx-auto max-w-5xl space-y-6">
      <div>
        <h1 className="text-2xl font-semibold text-white">Feed</h1>
        <p className="mt-1 text-sm text-zinc-500">Video recenti dei canali che segui. Clicca &quot;Genera&quot; su quello che vuoi trasformare in Short.</p>
      </div>

      {!connection ? (
        <div className="rounded-xl border border-dashed border-zinc-800 p-8 text-center text-sm text-zinc-500">
          Collega prima un account YouTube dalle{" "}
          <Link href="/dashboard/settings" className="text-brand-300 hover:underline">
            Impostazioni
          </Link>
          .
        </div>
      ) : !channels || channels.length === 0 ? (
        <div className="rounded-xl border border-dashed border-zinc-800 p-8 text-center text-sm text-zinc-500">
          Non segui ancora nessun canale. Aggiungine uno dalle{" "}
          <Link href="/dashboard/settings" className="text-brand-300 hover:underline">
            Impostazioni
          </Link>
          .
        </div>
      ) : (
        <VideoFeed />
      )}
    </div>
  );
}
