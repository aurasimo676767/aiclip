import fsp from "node:fs/promises";
import path from "node:path";
import { logger } from "../lib/logger.js";
import { storageProvider } from "../lib/providers.js";
import type { FaceLibraryIndex, LibraryFace } from "../lib/face-library.js";

/**
 * Pezzi della copertina long-form che non sono grafica: chi c'è nel video, quale faccia usare per
 * ognuno, e lo sfondo di gioco VERO da Steam. La grafica sta in render/compose-cover.ts.
 */

/**
 * Persone del video, nell'ordine in cui il titolo le nomina ("BLUR, MARZA, PESH E CHAT GIOCANO A..."),
 * fra quelle che hanno almeno una faccia con un nome in libreria. Lo streamer del VOD va sempre
 * per primo: è il protagonista (in una "BLUR REACTION" Blur deve esserci per forza).
 */
export function participantsFromTitle(title: string, library: FaceLibraryIndex, streamerAlias: string | null): string[] {
  const names = [...new Set(library.faces.filter((f) => f.status === "labeled" && f.label).map((f) => f.label!))];
  const upper = ` ${title.toUpperCase().replace(/[^\p{L}\p{N}]+/gu, " ")} `;
  const found = names
    .map((n) => ({ n, at: upper.indexOf(` ${n} `) }))
    .filter((x) => x.at >= 0)
    .sort((a, b) => a.at - b.at)
    .map((x) => x.n);
  const main = streamerAlias?.toUpperCase();
  if (main && names.includes(main)) return [main, ...found.filter((n) => n !== main)];
  return found;
}

const EXPRESSION_FALLBACK: Record<string, string[]> = {
  shock: ["urlo", "paura", "mani_in_testa"],
  urlo: ["shock", "rabbia", "mani_in_testa"],
  risata: ["sorriso", "shock"],
  rabbia: ["urlo", "sospetto"],
  paura: ["shock", "urlo", "mani_in_testa"],
  mani_in_testa: ["shock", "paura", "urlo"],
  sospetto: ["rabbia", "shock"],
  sorriso: ["risata", "sospetto"],
};

/**
 * Una faccia per persona (MAI la stessa persona due volte), la più adatta all'espressione chiesta:
 * prima l'espressione giusta, poi quelle vicine, poi la più esagerata. Fra facce equivalenti si
 * pesca a caso, così due copertine dello stesso streamer non escono identiche.
 */
export function pickFaces(library: FaceLibraryIndex, people: string[], expression: string | null, max: number): LibraryFace[] {
  const picked: LibraryFace[] = [];
  const wanted = expression ? [expression, ...(EXPRESSION_FALLBACK[expression] ?? [])] : [];
  for (const person of people) {
    if (picked.length >= max) break;
    const faces = library.faces.filter((f) => f.status === "labeled" && f.label === person);
    if (faces.length === 0) continue;
    const score = (f: LibraryFace) => {
      const rank = wanted.indexOf(f.expression);
      // Il busto conta più dell'espressione: una testa che galleggia rovina la copertina.
      return (f.bust === false ? -100 : f.bust ? 30 : 0) + (rank >= 0 ? (wanted.length - rank) * 10 : 0) + f.intensity * 2 + Math.random() * 3;
    };
    picked.push(faces.sort((a, b) => score(b) - score(a))[0]!);
  }
  return picked;
}

/** Scarica i PNG delle facce scelte nella cartella del job. */
export async function downloadFaces(faces: LibraryFace[], dir: string): Promise<string[]> {
  const paths: string[] = [];
  for (const f of faces) {
    const local = path.join(dir, `face-${f.id}.png`);
    await storageProvider.downloadToFile(f.path, local);
    paths.push(local);
  }
  return paths;
}

/**
 * Grafica ufficiale del gioco da Steam (la "library hero", 1920x620 senza scritte): è il gioco
 * VERO, mai un'immagine inventata. null se il gioco non è su Steam (giochi web, console): allora
 * lo sfondo resta un fotogramma della live.
 */
export async function findSteamHero(gameName: string, outPath: string): Promise<string | null> {
  try {
    const search = (await (
      await fetch(`https://store.steampowered.com/api/storesearch/?term=${encodeURIComponent(gameName)}&cc=it&l=italian`)
    ).json()) as { items?: Array<{ id: number; name: string }> };
    const item = bestMatch(gameName, search.items ?? []);
    if (!item) return null;
    for (const file of ["library_hero.jpg", "page_bg_raw.jpg", "header.jpg"]) {
      const res = await fetch(`https://cdn.akamai.steamstatic.com/steam/apps/${item.id}/${file}`);
      if (!res.ok) continue;
      await fsp.writeFile(outPath, Buffer.from(await res.arrayBuffer()));
      logger.info("Sfondo copertina da Steam", { gameName, steam: item.name, file });
      return outPath;
    }
  } catch (error) {
    logger.warn("Ricerca Steam fallita, sfondo dalla live", { gameName, error: error instanceof Error ? error.message : String(error) });
  }
  return null;
}

/** Il risultato Steam deve somigliare davvero al nome cercato: meglio nessuno sfondo Steam che il gioco sbagliato. */
function bestMatch(query: string, items: Array<{ id: number; name: string }>): { id: number; name: string } | null {
  const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
  const q = norm(query);
  const qWords = new Set(q.split(" ").filter((w) => w.length > 1));
  let best: { item: { id: number; name: string }; score: number } | null = null;
  for (const item of items.slice(0, 5)) {
    const n = norm(item.name);
    if (n === q) return item;
    const nWords = n.split(" ").filter((w) => w.length > 1);
    const common = nWords.filter((w) => qWords.has(w)).length;
    const score = common / Math.max(qWords.size, nWords.length);
    if (!best || score > best.score) best = { item, score };
  }
  return best && best.score >= 0.5 ? best.item : null;
}
