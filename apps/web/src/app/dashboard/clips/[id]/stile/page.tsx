import { notFound } from "next/navigation";
import { normalizeCaptionSettings, type CaptionTrack } from "@clipforge/shared";
import { requireUser } from "@/lib/auth";
import { getPresignedDownloadUrl, readTextObject } from "@/lib/storage/r2";
import { CaptionEditor } from "@/components/captions/caption-editor";
import { PollingRefresher } from "@/components/polling-refresher";

export const dynamic = "force-dynamic";

/** Editor dello stile dei sottotitoli di uno Short, con l'anteprima dal vivo sul video. */
export default async function ClipStylePage({ params }: { params: { id: string } }) {
  const { supabase, user } = await requireUser();
  const { data: clip } = await supabase.from("clips").select("*").eq("id", params.id).maybeSingle();
  if (!clip || clip.format === "longform") notFound();

  const [{ data: presets }, { data: profile }] = await Promise.all([
    supabase.from("caption_presets").select("id, name, settings").order("created_at", { ascending: true }),
    supabase.from("profiles").select("default_caption_settings").eq("id", user.id).maybeSingle(),
  ]);

  const sign = (path: string | null) => (path ? getPresignedDownloadUrl(path, 6 * 3600).catch(() => null) : Promise.resolve(null));
  const [previewUrl, finalUrl, poster, trackText] = await Promise.all([
    sign(clip.preview_video_path),
    clip.status === "COMPLETED" || clip.status === "QUEUED" || clip.status === "RENDERING" ? sign(clip.output_video_path) : Promise.resolve(null),
    sign(clip.cover_path ?? clip.thumbnail_path),
    clip.caption_track_path ? readTextObject(clip.caption_track_path).catch(() => null) : Promise.resolve(null),
  ]);
  let track: CaptionTrack | null = null;
  try {
    track = trackText ? (JSON.parse(trackText) as CaptionTrack) : null;
  } catch {
    track = null;
  }

  const defaultSettings = profile?.default_caption_settings ? normalizeCaptionSettings(profile.default_caption_settings) : null;
  const rendering = clip.status === "QUEUED" || clip.status === "RENDERING";

  return (
    <>
      <PollingRefresher active={rendering} intervalMs={5000} />
      <CaptionEditor
        key={`${clip.id}-${clip.updated_at}`}
        clip={{ id: clip.id, title: clip.title, projectId: clip.project_id, status: clip.status }}
        preview={previewUrl && track ? { videoUrl: previewUrl, track } : null}
        finalVideoUrl={finalUrl}
        poster={poster}
        initialSettings={normalizeCaptionSettings(clip.caption_settings ?? profile?.default_caption_settings ?? null)}
        userPresets={(presets ?? []).map((p) => ({ id: p.id, name: p.name, settings: normalizeCaptionSettings(p.settings) }))}
        defaultSettings={defaultSettings}
      />
    </>
  );
}
