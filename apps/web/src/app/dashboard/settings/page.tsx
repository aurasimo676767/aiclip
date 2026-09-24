import { requireUser } from "@/lib/auth";
import { YoutubeConnectionPanel } from "@/components/youtube-connection-panel";
import { FollowedChannelsPanel } from "@/components/followed-channels-panel";
import { FollowedTwitchChannelsPanel } from "@/components/followed-twitch-channels-panel";
import { PublishSchedulePanel } from "@/components/publish-schedule-panel";
import { Alert, PageHeader } from "@/components/ui";

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
  const { data: publishSchedule } = await supabase
    .from("publish_schedules")
    .select("short_times, longform_times")
    .eq("user_id", user.id)
    .maybeSingle();

  return (
    <div className="mx-auto max-w-4xl space-y-8">
      <PageHeader title="Opzioni" description="Collegamenti, canali seguiti e orari di pubblicazione." />

      {searchParams.youtube_connected && <Alert tone="success">Account YouTube collegato.</Alert>}
      {searchParams.youtube_error && <Alert>Connessione YouTube fallita: {searchParams.youtube_error}</Alert>}

      <div className="divide-y divide-line">
        <Section title="YouTube" description="Serve per pubblicare e programmare le clip direttamente da qui.">
          <YoutubeConnectionPanel channelTitle={youtubeConnection?.channel_title ?? null} />
        </Section>

        <Section title="Orari di pubblicazione" description="La griglia usata quando programmi più clip insieme.">
          <PublishSchedulePanel initialShortTimes={publishSchedule?.short_times ?? []} initialLongformTimes={publishSchedule?.longform_times ?? []} />
        </Section>

        <Section title="Canali Twitch" description="I loro VOD compaiono nel Feed, da trasformare in video long-form. Non serve nessuna connessione.">
          <FollowedTwitchChannelsPanel channels={(followedTwitchChannels ?? []).map((c) => ({ id: c.id, displayName: c.display_name }))} />
        </Section>

        {youtubeConnection && (
          <Section title="Canali YouTube" description="Canali da controllare: i video nuovi finiscono nel Feed, o li importi con una scansione.">
            <FollowedChannelsPanel channels={(followedChannels ?? []).map((c) => ({ id: c.id, channelTitle: c.channel_title }))} />
          </Section>
        )}

        <Section title="Account">
          <dl className="card divide-y divide-line text-sm">
            <Row label="Email" value={user.email ?? "—"} />
            <Row label="Piano" value={profile?.plan ?? "FREE"} />
            <Row label="Creato il" value={profile?.created_at ? new Date(profile.created_at).toLocaleDateString("it-IT") : "—"} />
          </dl>
        </Section>
      </div>
    </div>
  );
}

function Section({ title, description, children }: { title: string; description?: string; children: React.ReactNode }) {
  return (
    <section className="grid gap-4 py-7 first:pt-0 md:grid-cols-[14rem_1fr] md:gap-10">
      <div>
        <h2 className="section-title">{title}</h2>
        {description && <p className="mt-1 text-xs leading-relaxed text-muted">{description}</p>}
      </div>
      <div className="min-w-0">{children}</div>
    </section>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex justify-between gap-4 px-4 py-3">
      <dt className="text-muted">{label}</dt>
      <dd className="truncate text-ink">{value}</dd>
    </div>
  );
}
