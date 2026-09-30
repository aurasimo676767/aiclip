import { notFound } from "next/navigation";
import { DashboardShell } from "@/components/dashboard-shell";
import { ClipList, type ClipViewModel } from "@/components/clip-list";

/**
 * Anteprima SOLO in sviluppo (in produzione 404): i componenti veri con clip finte, per provare il
 * sito in formato telefono senza login. Nessun dato reale.
 */
export default function DevPreview() {
  if (process.env.NODE_ENV === "production") notFound();
  const base: ClipViewModel = {
    id: "x",
    title: "",
    hook: "Ci hanno derubato stanotte",
    reason: "Reazione forte e contesto chiaro",
    duration: 28,
    scores: { hook: 82, retention: 75, emotion: 80, clarity: 77, payoff: 74, virality: 79 },
    status: "COMPLETED",
    errorMessage: null,
    hashtags: ["blur", "marza", "pesh", "manuxo", "twitch", "live", "perte", "foryou"],
    caption: "fra 48 ore bro",
    publishDescription: "fra 48 ore bro\n\n#blur #marza #pesh #manuxo #twitch #live #perte #foryou",
    longformEdit: false,
    longformGames: null,
    longformKeepGames: null,
    youtubePublishStatus: null,
    tiktokStatus: null,
    tiktokError: null,
    tiktokPublishAt: null,
    youtubeUrl: null,
    youtubeError: null,
    youtubePublishAt: null,
    youtubeCancelledAt: null,
    badges: [],
    format: "short",
    thumbnailUrl: null,
    videoUrl: null,
  };
  const titles = [
    "Ci Hanno Derubato Stanotte",
    "HA MANGIATO i RAGNI 3 VOLTE..",
    "MANUXO TROVA BRUNO FERNANDES 🔥",
    "BLUR, MARZA, PESH, MANUXO chiudono il Torneo 2v2 con Super Volley Blast (Parte 3)",
    "CUCINA PIKACHU..",
    "Che Cazzo È Il Latte Crudo?",
  ];
  const clips: ClipViewModel[] = titles.map((title, i) => ({
    ...base,
    id: `c${i}`,
    title,
    format: i === 3 ? "longform" : "short",
    duration: i === 3 ? 5100 : 20 + i * 3,
    status: i === 4 ? "RENDERING" : i === 5 ? "SUGGESTED" : "COMPLETED",
    youtubeUrl: i === 1 ? "https://youtube.com/shorts/x" : null,
    tiktokStatus: i === 1 ? "COMPLETED" : i === 2 ? "FAILED" : null,
    longformGames: i === 3 ? [{ name: "Super Volley Blast", seconds: 1800 }, { name: "Rematch", seconds: 1200 }] : null,
  }));
  return (
    <DashboardShell email="anteprima@example.com">
      <div className="mx-auto max-w-7xl space-y-8">
        <h1 className="font-display text-2xl font-semibold text-ink">BLUR, MARZA, PESH, MANUXO e il Torneo 2v2 ad Alta Intensità con la Ruota</h1>
        <ClipList clips={clips} youtubeConnected />
      </div>
    </DashboardShell>
  );
}
