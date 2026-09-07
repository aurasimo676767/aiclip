import Link from "next/link";
import { notFound } from "next/navigation";
import { requireUser } from "@/lib/auth";
import { AllChannelVodsFeed } from "@/components/all-channel-vods-feed";

export default async function TwitchChannelVodsPage({ params }: { params: { id: string } }) {
  const { supabase, user } = await requireUser();

  const { data: channel } = await supabase
    .from("followed_twitch_channels")
    .select("id, display_name")
    .eq("id", params.id)
    .eq("user_id", user.id)
    .maybeSingle();
  if (!channel) {
    notFound();
  }

  return (
    <div className="mx-auto max-w-5xl space-y-6">
      <div>
        <Link href="/dashboard/feed" className="text-xs text-zinc-500 hover:text-zinc-300">
          ← Feed
        </Link>
        <h1 className="mt-1 text-2xl font-semibold text-white">{channel.display_name}</h1>
        <p className="mt-1 text-sm text-zinc-500">
          Tutti i VOD ancora disponibili su Twitch (in genere gli ultimi ~2 mesi, per limite della piattaforma).
        </p>
      </div>

      <AllChannelVodsFeed channelId={channel.id} />
    </div>
  );
}
