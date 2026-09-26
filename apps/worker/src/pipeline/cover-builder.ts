import fsp from "node:fs/promises";
import path from "node:path";
import sharp from "sharp";
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
export function pickFaces(
  library: FaceLibraryIndex,
  people: string[],
  expression: string | null,
  max: number,
  kind: "reaction" | "game" = "game",
): LibraryFace[] {
  const picked: LibraryFace[] = [];
  const wanted = expression ? [expression, ...(EXPRESSION_FALLBACK[expression] ?? [])] : [];
  for (const person of people) {
    if (picked.length >= max) break;
    const faces = library.faces.filter((f) => f.status === "labeled" && f.label === person && !f.tags?.includes("meme"));
    if (faces.length === 0) continue;
    const score = (f: LibraryFace) => {
      const rank = wanted.indexOf(f.expression);
      // Il busto conta più dell'espressione: una testa che galleggia rovina la copertina.
      // Tagliata su entrambi i lati: un taglio resterebbe in mezzo alla copertina (va sfumato), meglio evitarla.
      const cut = f.bothSidesCut ? -25 : 0;
      // Busto che non riempie il fondo (buchi, microfono tagliato via): lascia vuoti sul bordo basso.
      const base = f.baseCover !== undefined && f.baseCover < 0.5 ? -35 : 0;
      // In una reaction chi guarda un video non urla né si arrabbia: simo le ha bocciate ("non ha senso con una reaction").
      const mood = kind === "reaction" && (f.expression === "urlo" || f.expression === "rabbia") ? -40 : 0;
      return (f.bust === false ? -100 : f.bust ? 30 : 0) + cut + base + mood + (rank >= 0 ? (wanted.length - rank) * 10 : 0) + f.intensity * 2 + Math.random() * 3;
    };
    picked.push(faces.sort((a, b) => score(b) - score(a))[0]!);
  }
  return picked;
}

/**
 * Come vuole simo che appaiano certe persone nelle copertine GPT, oltre alla faccia. tag = foto della
 * libreria (etichetta `tags`) da passare per forza come riferimento, così il modello vede davvero
 * cappello e cuffie.
 */
export const PERSON_STYLE: Record<string, { note: string; tag?: string }> = {
  // simo, 2026-09-26: "blur, facciamolo SEMPRE con cuffie della redbull, o cappello della redbull".
  BLUR: { note: "always wearing his Red Bull cap or his Red Bull gaming headphones, exactly as in his reference photos that show them", tag: "redbull" },
};

/**
 * Foto di riferimento di una persona per GPT Image: quella scelta più altre buone (busti, meglio se
 * non tagliati ai due lati), diverse a ogni copertina. Più foto = faccia più fedele e pose varie.
 * Se la persona ha uno stile fisso (PERSON_STYLE), almeno due foto sono quelle con quello stile.
 */
export function referenceFaces(library: FaceLibraryIndex, chosen: LibraryFace, n: number): LibraryFace[] {
  // Pescate a caso fra le buone: con sempre le stesse foto GPT rifaceva sempre la stessa posa e gli
  // stessi vestiti (Blur con la sciarpa blu in ogni copertina, bocciato da simo).
  const good = library.faces.filter(
    (f) => f.status === "labeled" && f.label === chosen.label && f.id !== chosen.id && f.bust !== false && !f.tags?.includes("meme"),
  );
  const tag = chosen.label ? PERSON_STYLE[chosen.label]?.tag : undefined;
  const score = (f: LibraryFace) => (tag && f.tags?.includes(tag) ? 20 : 0) + (f.bothSidesCut ? 0 : 5) + f.intensity + Math.random() * 8;
  const ranked = good.sort((a, b) => score(b) - score(a));
  // Con uno stile fisso la foto scelta per la bozza può non averlo: la si mette dopo quelle giuste.
  if (tag && !chosen.tags?.includes(tag)) return [...ranked.slice(0, 2), chosen].slice(0, n);
  return [chosen, ...ranked.slice(0, n - 1)];
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
    const item = await findSteamApp(gameName);
    if (!item) return null;
    // Candidati: la grafica ufficiale e i primi screenshot veri del gioco. Si tiene il più colorato e
    // luminoso: la grafica ufficiale a volte è scurissima (Black Ops 2: un soldato nel buio, bocciato
    // da simo).
    const urls = [`https://cdn.akamai.steamstatic.com/steam/apps/${item.id}/library_hero.jpg`];
    const details = (await (await fetch(`https://store.steampowered.com/api/appdetails?appids=${item.id}`)).json()) as Record<
      string,
      { data?: { screenshots?: Array<{ path_full: string }> } }
    >;
    // La risposta è indicizzata con l'id del pacchetto, che non sempre è quello del gioco cercato.
    const shots = Object.values(details)[0]?.data?.screenshots ?? [];
    for (const shot of shots.slice(0, 7)) urls.push(shot.path_full);
    let best: { score: number; image: Buffer; url: string } | null = null;
    for (const url of urls) {
      const res = await fetch(url);
      if (!res.ok) continue;
      const image = Buffer.from(await res.arrayBuffer());
      const score = await vividness(image);
      if (!best || score > best.score) best = { score, image, url };
    }
    if (best) {
      await fsp.writeFile(outPath, best.image);
      logger.info("Sfondo copertina da Steam", { gameName, steam: item.name, url: best.url });
      return outPath;
    }
  } catch (error) {
    logger.warn("Ricerca Steam fallita, sfondo dalla live", { gameName, error: error instanceof Error ? error.message : String(error) });
  }
  return null;
}

/** Il gioco su Steam col nome più simile a quello cercato (null se nessuno somiglia abbastanza). */
async function findSteamApp(gameName: string): Promise<{ id: number; name: string } | null> {
  const search = (await (
    await fetch(`https://store.steampowered.com/api/storesearch/?term=${encodeURIComponent(gameName)}&cc=it&l=italian`)
  ).json()) as { items?: Array<{ id: number; name: string }> };
  return bestMatch(gameName, search.items ?? []);
}

/**
 * Logo VERO del gioco da Steam, da far mettere in copertina (come fa AvraiAuraBooter: QUIPLASH,
 * GOLF WITH YOUR FRIENDS, DUB TOGETHER in grande). Prima il logo trasparente; se il gioco non ce
 * l'ha, la testata ufficiale, che contiene il logo. null se il gioco non è su Steam.
 */
export async function findSteamLogo(gameName: string, outPath: string): Promise<string | null> {
  try {
    const item = await findSteamApp(gameName);
    if (!item) return null;
    for (const file of ["logo.png", "header.jpg"]) {
      const res = await fetch(`https://cdn.akamai.steamstatic.com/steam/apps/${item.id}/${file}`);
      if (!res.ok) continue;
      const target = outPath.replace(/\.[a-z]+$/i, file.endsWith(".png") ? ".png" : ".jpg");
      await fsp.writeFile(target, Buffer.from(await res.arrayBuffer()));
      return target;
    }
  } catch (error) {
    logger.warn("Logo Steam non trovato", { gameName, error: error instanceof Error ? error.message : String(error) });
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

/** Quanto un'immagine è colorata e luminosa (per scegliere lo sfondo): colore + luce + dettaglio. */
async function vividness(image: Buffer): Promise<number> {
  const { channels, entropy } = await sharp(image).resize(320, 180, { fit: "cover" }).stats();
  const [r, g, b] = channels;
  const brightness = (r!.mean + g!.mean + b!.mean) / 3;
  const colorfulness = Math.abs(r!.mean - g!.mean) + Math.abs(g!.mean - b!.mean) + (r!.stdev + g!.stdev + b!.stdev) / 3;
  return colorfulness * 0.6 + brightness * 0.5 + entropy * 8;
}
