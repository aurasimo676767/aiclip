import { requireUser } from "@/lib/auth";
import { PollingRefresher } from "@/components/polling-refresher";
import { VoiceoverUploadForm } from "@/components/voiceover-upload-form";
import { VoiceoverJobList, type VoiceoverJobViewModel } from "@/components/voiceover-job-list";

// Vedi commento in dashboard/batch/page.tsx: senza questo, su Vercel i dati possono restare
// cachati anche col polling attivo.
export const dynamic = "force-dynamic";

export default async function WhopPage() {
  const { supabase } = await requireUser();

  const { data: jobsRaw } = await supabase
    .from("voiceover_jobs")
    .select("id, title, status, error_message, video_original_filename, audio_original_filename, created_at")
    .order("created_at", { ascending: false });

  const jobs: VoiceoverJobViewModel[] = (jobsRaw ?? []).map((j) => ({
    id: j.id,
    title: j.title,
    status: j.status,
    errorMessage: j.error_message,
    videoFilename: j.video_original_filename,
    audioFilename: j.audio_original_filename,
    createdAt: j.created_at,
  }));

  const pollingActive = jobs.some((j) => j.status === "UPLOADING" || j.status === "PENDING" || j.status === "RENDERING");

  return (
    <div className="mx-auto max-w-3xl space-y-8">
      <PollingRefresher active={pollingActive} />

      <div>
        <h1 className="text-2xl font-semibold text-white">Whop</h1>
        <p className="mt-1 text-sm text-zinc-500">
          Carica una clip già pronta e un file audio (voice over): genera automaticamente uno Short verticale con l&apos;audio
          del voice over al posto di quello originale e sottotitoli una parola alla volta.
        </p>
      </div>

      <VoiceoverUploadForm />

      <section className="space-y-3">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-zinc-500">Le tue clip ({jobs.length})</h2>
        <VoiceoverJobList jobs={jobs} />
      </section>
    </div>
  );
}
