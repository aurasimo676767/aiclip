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
