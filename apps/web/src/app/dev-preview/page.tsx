import { notFound } from "next/navigation";
import type { ProjectSummary } from "@/lib/data/projects";
import type { ProjectDetail } from "@/lib/data/clips";
import { DashboardShell } from "@/components/dashboard-shell";
import type { ClipViewModel } from "@/components/clip-list";
import { HomeView } from "@/components/views/home-view";
import { ProjectView } from "@/components/views/project-view";

/**
 * Anteprima SOLO in sviluppo (in produzione 404): i componenti veri con dati finti, per provare il
 * sito (anche in formato telefono) senza login. Le immagini sono fotogrammi dei VOD scaricati sul PC
 * (public/dev-preview, fuori da git). ?v=home (predefinita) | project | processing
 */
export default function DevPreview({ searchParams }: { searchParams: { v?: string } }) {
  if (process.env.NODE_ENV === "production") notFound();
  const view = searchParams.v ?? "home";
  return (
    <DashboardShell email="anteprima@example.com">
      {view === "project" ? (
        <ProjectView detail={fakeDetail("READY")} youtubeConnected discardedVideoId={null} discardedShorts={[]} />
      ) : view === "processing" ? (
        <ProjectView detail={fakeDetail("TRANSCRIBING")} youtubeConnected discardedVideoId={null} discardedShorts={[]} />
      ) : (
        <HomeView summaries={fakeSummaries()} limit={12} />
      )}
    </DashboardShell>
  );
}

const img = (n: number) => `/dev-preview/f${n}.jpg`;

function fakeSummaries(): ProjectSummary[] {
  const rows: Array<[string, string, string, number, number, number, number | null, number]> = [
    // titolo, stato, sorgente, durata, clip, pronte, punteggio, immagine
    ["BLUR, MARZA, PESH, MANUXO e il Torneo 2v2 ad Alta Intensità con la Ruota", "READY", "twitch_vod", 17940, 9, 6, 88, 19],
    ["Kings League: il calciomercato in diretta", "ANALYZING", "twitch_vod", 12600, 0, 0, null, 20],
    ["Family Feud con la chat, parte 2", "READY", "twitch_vod", 7380, 6, 6, 81, 17],
    ["MARZA prova il latte crudo", "READY", "youtube", 1260, 7, 3, 76, 9],
    ["Size It Up: chi indovina le misure?", "READY", "youtube", 2280, 5, 1, 69, 3],
    ["Notte horror con Freddy", "FAILED", "youtube", 3300, 0, 0, null, 11],
    ["Il mixer nuovo di Pesh", "READY", "youtube", 960, 4, 4, 72, 5],
    ["Q&A con la chat", "DOWNLOADING", "twitch_vod", 9000, 0, 0, null, 1],
  ];
  return rows.map(([title, status, source, duration, clipCount, completedClipCount, topScore, image], i) => ({
    project: {
      id: `p${i}`,
      title,
      status,
      source_type: source,
      created_at: new Date(Date.now() - i * 26 * 3600_000).toISOString(),
    } as unknown as ProjectSummary["project"],
    video: { duration_seconds: duration, storage_path: i % 3 === 0 ? "x" : null } as unknown as ProjectSummary["video"],
    clipCount,
    completedClipCount,
    topScore,
    coverUrl: img(image),
  }));
}

function fakeDetail(status: string): ProjectDetail {
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
  const rows: Array<[string, number, string, number | null]> = [
    // titolo, punteggio medio circa, stato, immagine
    ["\"CI HANNO DERUBATO\"", 90, "COMPLETED", 13],
    ["HA MANGIATO i RAGNI 3 VOLTE..", 86, "COMPLETED", 15],
    ["MANUXO TROVA BRUNO FERNANDES 🔥", 81, "COMPLETED", 7],
    ["BLUR, MARZA, PESH, MANUXO chiudono il Torneo 2v2 con Super Volley Blast (Parte 3)", 79, "COMPLETED", 19],
    ["CUCINA PIKACHU..", 77, "RENDERING", 9],
    ["\"non ce la faccio più\"", 74, "COMPLETED", 2],
    ["pesh sbaglia tutto", 70, "SUGGESTED", null],
    ["IL TIRO DA CENTROCAMPO", 66, "SUGGESTED", 6],
    ["Che Cazzo È Il Latte Crudo?", 61, "SUGGESTED", null],
  ];
  const clips: ClipViewModel[] = rows.map(([title, score, clipStatus, image], i) => {
    const d = score - 78;
    return {
      ...base,
      id: `c${i}`,
      title,
      format: i === 3 ? "longform" : "short",
      duration: i === 3 ? 5100 : 19 + i * 4,
      status: clipStatus as ClipViewModel["status"],
      scores: { hook: 82 + d, retention: 75 + d, emotion: 80 + d, clarity: 77 + d, payoff: 74 + d, virality: 79 + d },
      thumbnailUrl: image ? img(image) : null,
      youtubeUrl: i === 1 || i === 0 ? "https://youtube.com/shorts/x" : null,
      youtubePublishAt: i === 0 ? new Date(Date.now() + 86400_000).toISOString() : null,
      tiktokStatus: i === 1 ? "COMPLETED" : i === 2 ? "FAILED" : null,
      longformGames: i === 3 ? [{ name: "Super Volley Blast", seconds: 1800 }, { name: "Rematch", seconds: 1200 }] : null,
    };
  });
  return {
    project: {
      id: "p0",
      title: "BLUR, MARZA, PESH, MANUXO e il Torneo 2v2 ad Alta Intensità con la Ruota",
      status,
      error_message: null,
      source_type: "twitch_vod",
    },
    video: { original_filename: "vod.mp4", duration_seconds: 17940, error_message: null, usageStats: null },
    clips: status === "READY" ? clips : [],
  };
}
