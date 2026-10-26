import { normalizeCaptionSettings } from "@clipforge/shared";
import { requireUser } from "@/lib/auth";
import { getPresignedDownloadUrl } from "@/lib/storage/r2";
import { PageHeader } from "@/components/ui";
import { StylesManager } from "@/components/captions/styles-manager";

export const dynamic = "force-dynamic";

/** Stili dei sottotitoli: preset personali e pronti, con l'esempio animato, e lo stile di partenza. */
export default async function StylesPage() {
  const { supabase, user } = await requireUser();
  const [{ data: presets }, { data: profile }, { data: latest }] = await Promise.all([
    supabase.from("caption_presets").select("id, name, settings").order("created_at", { ascending: true }),
    supabase.from("profiles").select("default_caption_settings").eq("id", user.id).maybeSingle(),
    supabase.from("clips").select("id, thumbnail_path").eq("status", "COMPLETED").neq("format", "longform").order("updated_at", { ascending: false }).limit(1).maybeSingle(),
  ]);
  const background = latest?.thumbnail_path ? await getPresignedDownloadUrl(latest.thumbnail_path, 6 * 3600).catch(() => null) : null;

  return (
    <div className="mx-auto max-w-5xl space-y-8">
      <PageHeader title="Stili sottotitoli" description="Ogni Short può avere il suo stile. Qui trovi i preset e scegli con quale stile escono i nuovi Shorts." />
      <StylesManager
        userPresets={(presets ?? []).map((p) => ({ id: p.id, name: p.name, settings: normalizeCaptionSettings(p.settings) }))}
        defaultSettings={profile?.default_caption_settings ? normalizeCaptionSettings(profile.default_caption_settings) : null}
        background={background}
        editHref={latest ? `/dashboard/clips/${latest.id}/stile` : null}
      />
    </div>
  );
}
