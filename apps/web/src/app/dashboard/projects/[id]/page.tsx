import { notFound } from "next/navigation";
import type { DiscardedShort } from "@clipforge/shared";
import { requireUser } from "@/lib/auth";
import { isProcessingStatus } from "@/components/status-badge";
import { PollingRefresher } from "@/components/polling-refresher";
import { ProjectView } from "@/components/views/project-view";
import { fetchProjectDetails, fetchYoutubeConnected } from "@/lib/data/clips";
// Vedi commento in dashboard/batch/page.tsx: senza questo, su Vercel i dati possono restare
// cachati anche col polling attivo.
export const dynamic = "force-dynamic";

export default async function ProjectDetailPage({ params }: { params: { id: string } }) {
  const { supabase, user } = await requireUser();

  const [details, youtubeConnected, discardedRes] = await Promise.all([
    fetchProjectDetails(supabase, [params.id]),
    fetchYoutubeConnected(supabase, user.id),
    // Query a parte: prima della migrazione 0034 la colonna non c'è e la pagina deve funzionare lo stesso.
    supabase.from("videos").select("id, discarded_shorts").eq("project_id", params.id).maybeSingle(),
  ]);
  const discardedVideoId = discardedRes.error ? null : (discardedRes.data?.id ?? null);
  const discardedShorts = discardedRes.error ? [] : ((discardedRes.data?.discarded_shorts as DiscardedShort[] | null) ?? []);
  const detail = details.get(params.id);
  if (!detail) {
    notFound();
  }
  const { project, clips } = detail;

  const projectProcessing = isProcessingStatus(project.status);
  const anyClipInFlight = clips.some((c) => c.status === "QUEUED" || c.status === "RENDERING");
  const anyPublishInFlight = clips.some((c) => c.youtubePublishStatus === "PENDING" || c.youtubePublishStatus === "UPLOADING");
  const pollingActive = projectProcessing || anyClipInFlight || anyPublishInFlight;

  return (
    <>
      <PollingRefresher active={pollingActive} />
      <ProjectView detail={detail} youtubeConnected={youtubeConnected} discardedVideoId={discardedVideoId} discardedShorts={discardedShorts} />
    </>
  );
}
