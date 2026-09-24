import Link from "next/link";
import { redirect } from "next/navigation";
import { ArrowRight, Captions, Crop, Radio, Sparkles } from "lucide-react";
import { createSupabaseServerClient } from "@/lib/supabase/server";

const FEATURES = [
  { icon: Sparkles, title: "Trova i momenti migliori", text: "L'AI legge tutta la live e sceglie i punti dove si urla, si ride, succede qualcosa." },
  { icon: Crop, title: "Montaggio verticale", text: "Webcam e gioco impaginati in 9:16, riconoscendo dove sta davvero la cam." },
  { icon: Captions, title: "Sottotitoli animati", text: "Una parola alla volta, sincronizzati sul parlato." },
  { icon: Radio, title: "VOD Twitch interi", text: "Divisi per gioco, reaction e torneo, pronti come video lunghi per YouTube." },
];

const SCORES = [94, 88, 81, 76];

export default async function HomePage() {
  const supabase = await createSupabaseServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (user) {
    redirect("/dashboard");
  }

  return (
    <main className="relative overflow-hidden">
      <div className="pointer-events-none absolute left-1/2 top-0 h-[30rem] w-[60rem] -translate-x-1/2 rounded-full bg-brand-500/20 blur-3xl" />
      <div className="pointer-events-none absolute right-0 top-40 h-72 w-96 rounded-full bg-hot/10 blur-3xl" />

      <header className="relative mx-auto flex max-w-6xl items-center justify-between px-6 py-6">
        <span className="flex items-center gap-2.5">
          <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-brand-gradient shadow-glow">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" aria-hidden>
              <path d="M8 5v14l11-7L8 5z" fill="white" />
            </svg>
          </span>
          <span className="font-display text-lg font-bold tracking-tight">ClipForge</span>
        </span>
        <Link href="/login" className="btn btn-ghost">
          Accedi
        </Link>
      </header>

      <section className="relative mx-auto max-w-6xl px-6 pb-24 pt-12 text-center sm:pt-20">
        <h1 className="mx-auto max-w-3xl text-balance font-display text-4xl font-semibold tracking-tight sm:text-6xl">
          Le tue live diventano <span className="bg-brand-gradient bg-clip-text text-transparent">Shorts</span> da sole
        </h1>
        <p className="mx-auto mt-5 max-w-xl text-balance text-base text-muted sm:text-lg">
          Incolla un link. L&apos;AI trova i momenti migliori, li monta in verticale con i sottotitoli e li programma su YouTube.
        </p>
        <div className="mt-8 flex justify-center gap-3">
          <Link href="/signup" className="btn btn-gradient btn-lg">
            Inizia gratis <ArrowRight size={18} />
          </Link>
          <Link href="/login" className="btn btn-secondary btn-lg">
            Accedi
          </Link>
        </div>

        {/* Anteprima del prodotto: una fila di clip con il punteggio */}
        <div className="mx-auto mt-16 grid max-w-3xl grid-cols-4 gap-3 sm:gap-4">
          {SCORES.map((score, i) => (
            <div
              key={score}
              className="relative aspect-[9/16] overflow-hidden rounded-2xl border border-line bg-raised shadow-card"
              style={{ transform: `translateY(${[0, 18, 6, 24][i]}px)` }}
            >
              <div className="absolute inset-0 bg-[radial-gradient(circle_at_30%_20%,rgba(124,92,255,0.45),transparent_60%),radial-gradient(circle_at_80%_90%,rgba(255,92,168,0.3),transparent_55%)]" />
              <div className="absolute inset-x-3 top-[18%] h-[28%] rounded-lg border border-white/15 bg-black/30" />
              <div className="absolute inset-x-3 bottom-[22%] space-y-1.5">
                <div className="h-2 rounded bg-white/80" />
                <div className="mx-auto h-2 w-2/3 rounded bg-yellow-300/90" />
              </div>
              <span className="absolute right-2 top-2 rounded-full bg-black/60 px-1.5 py-0.5 font-display text-[11px] font-bold text-emerald-300">{score}</span>
            </div>
          ))}
        </div>
      </section>

      <section className="relative mx-auto grid max-w-6xl gap-4 px-6 pb-24 sm:grid-cols-2 lg:grid-cols-4">
        {FEATURES.map(({ icon: Icon, title, text }) => (
          <div key={title} className="card p-5">
            <span className="flex h-9 w-9 items-center justify-center rounded-lg bg-brand-500/15 text-brand-300">
              <Icon size={18} />
            </span>
            <h3 className="mt-4 font-medium text-ink">{title}</h3>
            <p className="mt-1 text-sm leading-relaxed text-muted">{text}</p>
          </div>
        ))}
      </section>
    </main>
  );
}
