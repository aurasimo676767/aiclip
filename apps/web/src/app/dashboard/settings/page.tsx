import { requireUser } from "@/lib/auth";

export default async function SettingsPage() {
  const { supabase, user } = await requireUser();
  const { data: profile } = await supabase.from("profiles").select("*").eq("id", user.id).single();

  return (
    <div className="mx-auto max-w-2xl space-y-6">
      <h1 className="text-2xl font-semibold text-white">Impostazioni</h1>

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

      <p className="text-xs text-zinc-600">
        Gestione fatturazione e upgrade piano non ancora disponibili in questa fase.
      </p>
    </div>
  );
}
