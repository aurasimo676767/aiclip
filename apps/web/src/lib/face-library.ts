import "server-only";
import { readTextObject, writeTextObject } from "./storage/r2";

/**
 * Libreria delle facce per le copertine (stesso formato di apps/worker/src/lib/face-library.ts):
 * face-library/<userId>/index.json su R2. Il NOME di ogni faccia lo mette solo simo da questa app;
 * l'AI non deduce mai chi è una persona.
 */
export interface LibraryFace {
  id: string;
  path: string;
  expression: string;
  intensity: number;
  sourceVideoId: string;
  label: string | null;
  status: "candidate" | "labeled" | "rejected";
}

export const faceIndexKey = (userId: string) => `face-library/${userId}/index.json`;

/** Nomi proposti come scelta rapida: gli alias già usati nei titoli più chi compare spesso nelle copertine. */
export const SUGGESTED_FACE_NAMES = ["BLUR", "MARZA", "PESH", "MANUXO", "ZAZZONE", "KUROLILY", "FAZZONE"];

export async function readFaceIndex(userId: string): Promise<{ faces: LibraryFace[] }> {
  const text = await readTextObject(faceIndexKey(userId));
  if (!text) return { faces: [] };
  return JSON.parse(text) as { faces: LibraryFace[] };
}

export async function writeFaceIndex(userId: string, index: { faces: LibraryFace[] }): Promise<void> {
  await writeTextObject(faceIndexKey(userId), JSON.stringify(index));
}
