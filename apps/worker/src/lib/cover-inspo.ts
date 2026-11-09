import fsp from "node:fs/promises";
import path from "node:path";
import sharp from "sharp";
import { storageProvider } from "./providers.js";
import { detectFaces } from "../face-tracking/onnx-face-detector.js";
import { detectFaceBoxes } from "../face-tracking/face-identity.js";

/**
 * "Allenamento" delle copertine (simo, 2026-11-09: "100x più intelligente, da allenare seguendo le
 * copertine di tanti canali"). Non è un modello addestrato: è una libreria delle copertine dei canali
 * che simo segue, ognuna studiata una volta dall'AI (scritta, scena, composizione, perché funziona) e
 * pesata con le visualizzazioni rispetto alla media del suo canale. Alla copertina nuova si passano
 * le più simili che hanno funzionato di più: le parole della scritta, l'idea della scena e una di
 * loro come immagine di riferimento (facce coperte, se no GPT Image copia le persone).
 * Sta su R2 come la libreria delle facce, senza migrazioni: cover-inspo/<userId>/config.json (canali,
 * richiesta di allenamento, avanzamento) e index.json (copertine). Lo stesso formato lo legge e lo
 * scrive il sito (apps/web/src/lib/cover-inspo.ts).
 */

export interface InspoChannel {
  /** Link del canale YouTube (anche solo @nome). */
  url: string;
  name?: string;
}

export interface InspoConfig {
  channels: InspoChannel[];
  /** Messo dal sito col pulsante "Allena adesso": il worker allena se è più recente di lastTrainedAt. */
  trainRequestedAt?: string | null;
  lastTrainedAt?: string | null;
  /** Allenamento in corso (per la barra sul sito); null quando non ce n'è. */
  training?: { startedAt: string; done: number; total: number; step: string } | null;
  lastError?: string | null;
  /** Riassunto dell'ultimo allenamento, mostrato sul sito. */
  lastSummary?: string | null;
}

export interface InspoAnalysis {
  kind: "reaction" | "game" | "altro";
  game: string | null;
  /** La scritta grande, parola per parola (null se non c'è). */
  text: string | null;
  textStyle: string;
  people: number;
  expressions: string;
  /** Cosa si vede: chi fa cosa, sfondo, oggetti, costumi. In inglese, va dritto nel prompt di GPT Image. */
  scene: string;
  composition: string;
  /** Perché attira il clic, in una frase. */
  hook: string;
}

export interface InspoItem {
  videoId: string;
  channel: string;
  /** Il link del canale com'è nella lista di simo: se un giro non riesce a leggerlo, le sue copertine restano. */
  channelUrl?: string;
  title: string;
  views: number | null;
  /** AAAAMMGG (approssimata da YouTube). */
  uploadDate: string | null;
  /** Visualizzazioni diviso la mediana del canale: 3 = ha fatto il triplo del solito. null = troppo recente per dirlo. */
  outlier: number | null;
  /** "canale" = dai canali seguiti; "approvata" = copertina di simo caricata col pulsante "Carica". */
  source: "canale" | "approvata";
  /** JPEG 1280x720 su storage. */
  path: string;
  analysis?: InspoAnalysis;
  addedAt: string;
}

export interface InspoIndex {
  items: InspoItem[];
}

export const inspoRoot = (userId: string) => `cover-inspo/${userId}`;
const configKey = (userId: string) => `${inspoRoot(userId)}/config.json`;
const indexKey = (userId: string) => `${inspoRoot(userId)}/index.json`;

/** Canali già guardati per le copertine (vedi memoria copertine-come-le-vuole): la partenza se simo non ne ha messi. */
export const DEFAULT_INSPO_CHANNELS: InspoChannel[] = [
  { url: "https://www.youtube.com/@AvraiAuraBooter", name: "Avrai Aura Booter" },
  { url: "https://www.youtube.com/@BlurIndietro", name: "Blur Indietro" },
  { url: "https://www.youtube.com/@SdrogoLoco", name: "SdrogoLoco" },
];

async function readJson<T>(key: string, workDir: string, fallback: T): Promise<T> {
  const local = path.join(workDir, `inspo-${path.basename(key)}-${process.pid}-${Date.now()}`);
  try {
    await storageProvider.downloadToFile(key, local);
    return JSON.parse(await fsp.readFile(local, "utf8")) as T;
  } catch {
    return fallback;
  } finally {
    await fsp.rm(local, { force: true });
  }
}

async function writeJson(key: string, value: unknown, workDir: string): Promise<void> {
  const local = path.join(workDir, `inspo-${path.basename(key)}-${process.pid}-${Date.now()}`);
  await fsp.writeFile(local, JSON.stringify(value));
  try {
    await storageProvider.uploadFile(local, key, "application/json");
  } finally {
    await fsp.rm(local, { force: true });
  }
}

export const readInspoConfig = (userId: string, workDir: string) => readJson<InspoConfig | null>(configKey(userId), workDir, null);
export const writeInspoConfig = (userId: string, config: InspoConfig, workDir: string) => writeJson(configKey(userId), config, workDir);
export const readInspoIndex = (userId: string, workDir: string) => readJson<InspoIndex>(indexKey(userId), workDir, { items: [] });
export const writeInspoIndex = (userId: string, index: InspoIndex, workDir: string) => writeJson(indexKey(userId), index, workDir);

/** Peso delle copertine approvate da simo: contano come una copertina che ha fatto il triplo del solito. */
const APPROVED_OUTLIER = 3;

/**
 * Quanto ha funzionato (0 = come il solito del canale, negativo = peggio), in scala logaritmica e
 * con un tetto basso: AvraiAuraBooter ha video da 80 volte il suo solito (mediana bassissima) e con
 * un tetto alto le sue copertine passavano davanti a quelle dello stesso tipo di video (2026-11-09:
 * per il Torneo della Porca Madonna in cima una reaction a Ciccio, il torneo vero ottavo).
 */
function performance(item: InspoItem): number {
  const outlier = item.source === "approvata" ? APPROVED_OUTLIER : item.outlier;
  return outlier ? 0.75 * Math.log2(Math.max(0.25, Math.min(outlier, 4))) : 0;
}

/** Parole che non dicono di che video si tratta: i nomi degli streamer sono in quasi tutti i titoli. */
const NOISE = new Set(
  "blur marza pesh manuxo manuuxo kurolily fazzone zazzone lollo con del della dei delle che piu mai stato fatto sempre nel nella per una uno gli sono the and with".split(" "),
);

const words = (text: string | null | undefined) =>
  new Set(
    (text ?? "")
      .toLowerCase()
      .normalize("NFD")
      .replace(/[̀-ͯ]/g, "")
      .split(/[^a-z0-9]+/)
      .filter((w) => w.length > 2 && !NOISE.has(w)),
  );

/**
 * Le copertine da mostrare all'AI per un video: stesso gioco prima, poi stesso tipo (reaction/gioco),
 * poi le parole del titolo in comune; dentro ogni gruppo vincono quelle che hanno fatto più
 * visualizzazioni del solito. Una per video, al massimo 2 dallo stesso canale di fila in cima.
 */
export function pickInspiration(index: InspoIndex, ctx: { kind?: "reaction" | "game" | null; game?: string | null; title: string }, count: number): InspoItem[] {
  const titleWords = words(ctx.title);
  const gameWords = words(ctx.game);
  const scored = index.items
    .filter((item) => item.analysis)
    .map((item) => {
      const a = item.analysis!;
      let relevance = 0;
      const itemGame = words(`${a.game ?? ""} ${item.title}`);
      if (gameWords.size > 0 && [...gameWords].every((w) => itemGame.has(w))) relevance += 3;
      else if (gameWords.size > 0 && [...gameWords].some((w) => itemGame.has(w))) relevance += 1.5;
      if (ctx.kind && a.kind === ctx.kind) relevance += 1;
      const shared = [...words(item.title)].filter((w) => titleWords.has(w)).length;
      relevance += Math.min(2.5, shared * 0.8);
      return { item, score: relevance + performance(item) };
    })
    .sort((a, b) => b.score - a.score);
  const out: InspoItem[] = [];
  const perChannel = new Map<string, number>();
  for (const { item } of scored) {
    if (out.length >= count) break;
    const n = perChannel.get(item.channel) ?? 0;
    if (n >= Math.max(2, Math.ceil(count / 2))) continue;
    perChannel.set(item.channel, n + 1);
    out.push(item);
  }
  return out;
}

/**
 * true se la scritta scelta è presa da una delle copertine mostrate: tutte le sue parole stanno in
 * quella scritta (2026-11-09: per il Torneo della Porca Madonna l'AI ha scritto "TORNEO TUTTI",
 * dalla copertina di Blur Indietro "TORNEO TUTTI CONTRO TUTTI", anche col divieto nel prompt).
 */
export function copiesInspiration(text: string, items: InspoItem[]): boolean {
  const mine = [...words(text)];
  if (mine.length === 0) return false;
  return items.some((item) => {
    const theirs = words(item.analysis?.text);
    return theirs.size > 0 && mine.every((w) => theirs.has(w));
  });
}

/** Le copertine scelte come testo per l'AI che decide scritta e scena (numerate da 1, il numero torna in inspirationIndex). */
export function describeInspiration(items: InspoItem[]): string {
  return items
    .map((item, i) => {
      const a = item.analysis!;
      const perf =
        item.source === "approvata"
          ? "approvata dal proprietario del canale"
          : item.outlier
            ? `${item.outlier >= 1 ? `${item.outlier.toFixed(1)}x` : `${item.outlier.toFixed(2)}x`} le visualizzazioni solite del canale`
            : "troppo recente per i numeri";
      return [
        `${i + 1}. [${item.channel}, ${perf}] titolo "${item.title}"`,
        `   scritta: ${a.text ? `"${a.text}"` : "nessuna"} (${a.textStyle})`,
        `   tipo: ${a.kind}${a.game ? `, gioco ${a.game}` : ""}; persone: ${a.people}, ${a.expressions}`,
        `   scena: ${a.scene}`,
        `   composizione: ${a.composition}`,
        `   perché funziona: ${a.hook}`,
      ].join("\n");
    })
    .join("\n");
}

/**
 * Copia della copertina di riferimento con le facce coperte, per GPT Image: con le facce visibili
 * disegnava le persone dell'esempio al posto delle nostre (successo con la copertina-modello intera,
 * 2026-09-26). Si tiene tutto il resto: impaginazione, luce, colori, oggetti, stile della scritta.
 */
export async function referenceWithHiddenFaces(coverPath: string, outputPath: string): Promise<string> {
  const W = 1280;
  const H = 720;
  const cover = await sharp(coverPath).resize(W, H, { fit: "cover" }).removeAlpha().toBuffer();
  // Le facce enormi e tagliate dal bordo delle copertine le prende solo YuNet (il rilevatore leggero
  // ne prendeva solo gli occhi, provato 2026-11-09); quello leggero si tiene in più per le facce
  // piccole sullo sfondo. Coprire una faccia di troppo non fa danni, lasciarne una sì.
  const rgb = await sharp(cover).resize(320, 240, { fit: "fill" }).raw().toBuffer();
  const bgr = Buffer.alloc(rgb.length);
  for (let i = 0; i < rgb.length; i += 3) {
    bgr[i] = rgb[i + 2]!;
    bgr[i + 1] = rgb[i + 1]!;
    bgr[i + 2] = rgb[i]!;
  }
  const faces = [...(await detectFaceBoxes(cover)), ...(await detectFaces(bgr, W, H)).filter((f) => f.score > 0.5)];
  const patches = await Promise.all(
    faces.map(async (f) => {
      // Il volto con un po' di margine; a volte il rilevatore prende solo gli occhi (riquadro basso e
      // largo): si allunga a un quadrato verso il basso, dove ci sono naso e bocca.
      const side = Math.max(f.width, f.height);
      const cx = f.x + f.width / 2;
      const left = Math.max(0, Math.round(cx - side * 0.6));
      const top = Math.max(0, Math.round(f.y - side * 0.15));
      const width = Math.min(W - left, Math.round(side * 1.2));
      const height = Math.min(H - top, Math.round(side * 1.3));
      if (width < 8 || height < 8) return null;
      // Sfocata fortissima, con i colori: si capisce dove sta una testa e quanto è grande (serve
      // all'impaginazione) ma non chi è. Bordi sfumati per non lasciare un riquadro netto.
      const blurred = await sharp(cover).extract({ left, top, width, height }).blur(Math.max(8, side / 6)).modulate({ saturation: 0.6 }).raw().toBuffer();
      const mask = await sharp(Buffer.from(`<svg width="${width}" height="${height}"><rect width="100%" height="100%" fill="black"/><ellipse cx="${width / 2}" cy="${height / 2}" rx="${width * 0.46}" ry="${height * 0.46}" fill="white"/></svg>`))
        .blur(Math.max(4, side / 20))
        .extractChannel(0)
        .raw()
        .toBuffer();
      const input = await sharp(blurred, { raw: { width, height, channels: 3 } }).joinChannel(mask, { raw: { width, height, channels: 1 } }).png().toBuffer();
      return { input, left, top };
    }),
  );
  await sharp(cover)
    .composite(patches.filter((p): p is NonNullable<typeof p> => p !== null))
    .jpeg({ quality: 90 })
    .toFile(outputPath);
  return outputPath;
}
