import fsp from "node:fs/promises";
import path from "node:path";
import sharp from "sharp";
import { storageProvider } from "./providers.js";

/**
 * Libreria delle facce per le copertine: ritagli presi dalle copertine dei canali, con il NOME che
 * mette simo dalla pagina "Facce" del sito (mai dedotto dall'AI). Sta su R2 e non nel database così
 * si usa senza migrazioni: face-library/<userId>/index.json + face-library/<userId>/<id>.png.
 * Lo stesso formato lo legge e lo scrive il sito (apps/web/src/lib/face-library.ts).
 */

export interface LibraryFace {
  id: string;
  /** Percorso su storage del PNG scontornato. */
  path: string;
  expression: string;
  /** 1-5, quanto è esagerata l'espressione. */
  intensity: number;
  sourceVideoId: string;
  /** Nome in maiuscolo (es. "BLUR") messo da simo; null finché non lo mette. */
  label: string | null;
  status: "candidate" | "labeled" | "rejected";
  /** Busto (spalle sul fondo) invece di sola testa: vedi isBustCutout. Assente = non ancora misurato. */
  bust?: boolean;
  /** Tagliata su entrambi i lati (tipico delle schermate della webcam): vedi measureCutout. */
  bothSidesCut?: boolean;
}

export interface FaceLibraryIndex {
  faces: LibraryFace[];
}

export const faceLibraryRoot = (userId: string) => `face-library/${userId}`;
export const faceLibraryIndexKey = (userId: string) => `${faceLibraryRoot(userId)}/index.json`;

export async function readFaceLibrary(userId: string, workDir: string): Promise<FaceLibraryIndex> {
  const local = path.join(workDir, `face-index-${userId}.json`);
  try {
    await storageProvider.downloadToFile(faceLibraryIndexKey(userId), local);
    return JSON.parse(await fsp.readFile(local, "utf8")) as FaceLibraryIndex;
  } catch {
    return { faces: [] };
  } finally {
    await fsp.rm(local, { force: true });
  }
}

export async function writeFaceLibrary(userId: string, index: FaceLibraryIndex, workDir: string): Promise<void> {
  const local = path.join(workDir, `face-index-${userId}.json`);
  await fsp.writeFile(local, JSON.stringify(index));
  await storageProvider.uploadFile(local, faceLibraryIndexKey(userId), "application/json");
  await fsp.rm(local, { force: true });
}

/**
 * true se il ritaglio è un BUSTO (spalle larghe sul fondo) e non solo una testa: in copertina i
 * busti salgono dal bordo, una testa da sola sembra galleggiare (macabro, parole di simo).
 * Guarda l'ultimo 8% delle righe: quanta larghezza è occupata dalla persona.
 */
export async function isBustCutout(png: Buffer): Promise<boolean> {
  const { data, info } = await sharp(png).ensureAlpha().extractChannel(3).raw().toBuffer({ resolveWithObject: true });
  const rows = Math.max(1, Math.round(info.height * 0.08));
  let covered = 0;
  for (let y = info.height - rows; y < info.height; y++) {
    for (let x = 0; x < info.width; x++) if (data[y * info.width + x]! > 128) covered++;
  }
  // 20%: i busti in diagonale (una spalla, un braccio davanti) coprono il 20-35% del fondo, le
  // teste da sole meno del 10% (misurato sulle foto di Marza).
  return covered / (rows * info.width) > 0.2 && info.width / info.height > 0.6;
}

export interface CutoutShape {
  /** Riquadro stretto attorno alla persona (alpha > 128). */
  box: { left: number; top: number; width: number; height: number };
  /** Da che lati la persona è TAGLIATA (tocca il bordo del riquadro per un bel tratto). */
  cuts: { left: boolean; right: boolean; top: boolean };
  /** Lunghezza del taglio sui lati, frazione dell'altezza: il più lungo va contro il bordo della copertina. */
  leftCover: number;
  rightCover: number;
}

/**
 * Forma del ritaglio: il riquadro stretto attorno alla persona e i lati tagliati. In copertina un
 * lato tagliato va contro il bordo di un angolo; tagliata in alto (testa mozzata) non si usa.
 */
export async function measureCutout(png: Buffer): Promise<CutoutShape> {
  const { data, info } = await sharp(png).ensureAlpha().extractChannel(3).raw().toBuffer({ resolveWithObject: true });
  const w = info.width;
  const h = info.height;
  let x0 = w;
  let x1 = -1;
  let y0 = h;
  let y1 = -1;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (data[y * w + x]! <= 128) continue;
      if (x < x0) x0 = x;
      if (x > x1) x1 = x;
      if (y < y0) y0 = y;
      if (y > y1) y1 = y;
    }
  }
  if (x1 < 0) throw new Error("Ritaglio vuoto");
  const cw = x1 - x0 + 1;
  const ch = y1 - y0 + 1;
  const colCover = (x: number) => {
    let c = 0;
    for (let y = y0; y <= y1; y++) if (data[y * w + x]! > 128) c++;
    return c / ch;
  };
  const rowCover = (y: number) => {
    let c = 0;
    for (let x = x0; x <= x1; x++) if (data[y * w + x]! > 128) c++;
    return c / cw;
  };
  const band = (f: (i: number) => number, idx: number[]) => Math.max(...idx.filter((i) => i >= 0).map(f));
  const leftCover = band(colCover, [x0, x0 + 1, x0 + 2, x0 + 3].filter((x) => x <= x1));
  const rightCover = band(colCover, [x1, x1 - 1, x1 - 2, x1 - 3].filter((x) => x >= x0));
  const topCover = band(rowCover, [y0, y0 + 1, y0 + 2, y0 + 3].filter((y) => y <= y1));
  // 8% dell'altezza: una spalla o una felpa che finisce contro il bordo. La cima della testa dopo il
  // ritaglio stretto copre pochi pixel; una testa mozzata copre un quarto della larghezza e oltre.
  return {
    box: { left: x0, top: y0, width: cw, height: ch },
    cuts: { left: leftCover > 0.08, right: rightCover > 0.08, top: topCover > 0.25 },
    leftCover,
    rightCover,
  };
}
