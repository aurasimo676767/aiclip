import { NextResponse } from "next/server";
import { z } from "zod";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { DEFAULT_INSPO_CHANNELS, readInspoConfig, readInspoIndex, writeInspoConfig } from "@/lib/cover-inspo";
import { getPresignedDownloadUrl } from "@/lib/storage/r2";

const bodySchema = z.object({
  /** Canali da seguire (link o @nome): sostituiscono la lista salvata. */
  channels: z.array(z.object({ url: z.string().trim().min(2).max(300), name: z.string().trim().max(80).optional() })).max(40).optional(),
  /** true = "Allena adesso": il worker lo vede entro 2 minuti. */
  train: z.boolean().optional(),
});

/** Copertine da mostrare come "cosa ha imparato": le migliori rispetto al solito del loro canale. */
const SHOWN = 12;

async function currentUser() {
  const supabase = await createSupabaseServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  return user;
}

export async function GET() {
  const user = await currentUser();
  if (!user) return NextResponse.json({ error: "Non autenticato" }, { status: 401 });
  const [config, index] = await Promise.all([readInspoConfig(user.id), readInspoIndex(user.id)]);
  const studied = index.items.filter((i) => i.analysis);
  const best = [...studied]
    .sort((a, b) => (b.source === "approvata" ? 3 : (b.outlier ?? 0)) - (a.source === "approvata" ? 3 : (a.outlier ?? 0)))
    .slice(0, SHOWN);
  const top = await Promise.all(
    best.map(async (i) => ({
      videoId: i.videoId,
      channel: i.channel,
      title: i.title,
      views: i.views,
      outlier: i.outlier,
      approved: i.source === "approvata",
      text: i.analysis?.text ?? null,
      hook: i.analysis?.hook ?? "",
      url: await getPresignedDownloadUrl(i.path, 6 * 3600),
    })),
  );
  return NextResponse.json({
    channels: config?.channels ?? DEFAULT_INSPO_CHANNELS,
    saved: Boolean(config),
    trainRequestedAt: config?.trainRequestedAt ?? null,
    lastTrainedAt: config?.lastTrainedAt ?? null,
    training: config?.training ?? null,
    lastError: config?.lastError ?? null,
    lastSummary: config?.lastSummary ?? null,
    counts: { total: studied.length, approved: studied.filter((i) => i.source === "approvata").length },
    top,
  });
}

export async function POST(request: Request) {
  const user = await currentUser();
  if (!user) return NextResponse.json({ error: "Non autenticato" }, { status: 401 });
  const parsed = bodySchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "Richiesta non valida" }, { status: 400 });

  const config = (await readInspoConfig(user.id)) ?? { channels: DEFAULT_INSPO_CHANNELS };
  if (parsed.data.channels) {
    const seen = new Set<string>();
    config.channels = parsed.data.channels.filter((c) => {
      const key = c.url.toLowerCase().replace(/\/+$/, "");
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  }
  if (parsed.data.train) {
    if (config.channels.length === 0) return NextResponse.json({ error: "Aggiungi almeno un canale" }, { status: 400 });
    config.trainRequestedAt = new Date().toISOString();
  }
  await writeInspoConfig(user.id, config);
  return NextResponse.json({ ok: true });
}
