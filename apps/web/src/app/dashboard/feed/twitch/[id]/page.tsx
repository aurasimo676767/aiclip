import Link from "next/link";
import { notFound } from "next/navigation";
import { requireUser } from "@/lib/auth";
import { ArrowLeft } from "lucide-react";
import { AllChannelVodsFeed } from "@/components/all-channel-vods-feed";
import { PageHeader } from "@/components/ui";

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
    <div className="mx-auto max-w-6xl space-y-8">
      <div className="space-y-4">
        <Link href="/dashboard/feed" className="inline-flex items-center gap-1.5 text-sm text-muted transition hover:text-ink">
          <ArrowLeft size={15} /> Feed
        </Link>
        <PageHeader title={channel.display_name} description="Tutti i VOD ancora disponibili su Twitch (di solito gli ultimi ~2 mesi)." />
      </div>

      <AllChannelVodsFeed channelId={channel.id} />
    </div>
  );
}
