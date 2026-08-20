import { PLAN_LIMITS, type Plan } from "@clipforge/shared";
import { requireUser } from "@/lib/auth";

export default async function CreditsPage() {
  const { supabase, user } = await requireUser();

  const { data: profile } = await supabase
    .from("profiles")
    .select("plan, credits, processing_minutes_used, storage_used_bytes")
    .eq("id", user.id)
    .single();

  const { data: usageRows } = await supabase
    .from("usage")
    .select("period_start, period_end, minutes_processed, clips_generated, storage_bytes")
    .eq("user_id", user.id)
    .order("period_start", { ascending: false })
    .limit(6);

  const plan = (profile?.plan ?? "FREE") as Plan;
  const limits = PLAN_LIMITS[plan];

  return (
    <div className="mx-auto max-w-3xl space-y-8">
      <h1 className="text-2xl font-semibold text-white">Credits & Usage</h1>

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
        <StatCard label="Piano" value={plan} />
        <StatCard label="Crediti" value={String(profile?.credits ?? 0)} />
        <StatCard
          label="Minuti elaborati"
          value={`${Math.round(profile?.processing_minutes_used ?? 0)} / ${limits.monthlyProcessingMinutes}`}
        />
      </div>

      <div className="rounded-xl border border-zinc-800 bg-zinc-900/40 p-5">
        <h2 className="mb-3 text-sm font-semibold text-zinc-300">Limiti piano {plan}</h2>
        <dl className="grid grid-cols-2 gap-3 text-sm sm:grid-cols-4">
          <Metric label="Minuti/mese" value={String(limits.monthlyProcessingMinutes)} />
          <Metric label="Clip/mese" value={String(limits.monthlyClips)} />
          <Metric label="Storage" value={`${Math.round(limits.storageBytes / 1024 / 1024 / 1024)} GB`} />
          <Metric label="Max upload" value={`${Math.round(limits.maxUploadSizeBytes / 1024 / 1024)} MB`} />
        </dl>
      </div>

      <div>
        <h2 className="mb-3 text-sm font-semibold text-zinc-300">Storico utilizzo</h2>
        {usageRows && usageRows.length > 0 ? (
          <div className="overflow-hidden rounded-xl border border-zinc-800">
            <table className="w-full text-sm">
              <thead className="bg-zinc-900/60 text-left text-zinc-500">
                <tr>
                  <th className="px-4 py-2 font-medium">Periodo</th>
                  <th className="px-4 py-2 font-medium">Minuti</th>
                  <th className="px-4 py-2 font-medium">Clip generate</th>
                  <th className="px-4 py-2 font-medium">Storage</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-zinc-800 text-zinc-300">
                {usageRows.map((row) => (
                  <tr key={row.period_start}>
                    <td className="px-4 py-2">{row.period_start}</td>
                    <td className="px-4 py-2">{Math.round(row.minutes_processed)}</td>
                    <td className="px-4 py-2">{row.clips_generated}</td>
                    <td className="px-4 py-2">{(row.storage_bytes / 1024 / 1024).toFixed(0)} MB</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <p className="text-sm text-zinc-500">Nessun utilizzo registrato ancora.</p>
        )}
      </div>
    </div>
  );
}

function StatCard({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-xl border border-zinc-800 bg-zinc-900/40 p-4">
      <p className="text-xs text-zinc-500">{label}</p>
      <p className="mt-1 text-xl font-semibold text-white">{value}</p>
    </div>
  );
}

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt className="text-xs text-zinc-500">{label}</dt>
      <dd className="text-zinc-200">{value}</dd>
    </div>
  );
}
