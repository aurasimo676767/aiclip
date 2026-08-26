import { runFfmpeg } from "../lib/ffmpeg.js";

const SCENE_CUT_THRESHOLD = 0.3; // soglia standard del filtro "scene" di ffmpeg per un taglio netto (0-1, differenza media tra frame consecutivi)

/**
 * Rileva i tagli netti (hard cut, es. l'editor passa da schermo intero reactor a schermo
 * intero contenuto reagito) dentro [absStart, absStart+duration] del video sorgente, usando il
 * filtro `scene` di ffmpeg (differenza pixel tra frame consecutivi, nessun modello ML) — molto
 * più economico della detection volti, usato per allineare i confini dei segmenti di
 * reaction-cam-face-tracker.ts ai tagli REALI invece di una griglia temporale fissa, così
 * nessun segmento finisce per mescolare due inquadrature diverse nella stessa media (osservato
 * in pratica: un taglio a metà segmento produceva un crop centrato a metà tra le due scene,
 * sbagliato per entrambe). Ritorna i timestamp CLIP-RELATIVI (0 = absStart) dei tagli rilevati.
 */
export async function detectSceneCuts(videoPath: string, absStart: number, duration: number): Promise<number[]> {
  let stderr: string;
  try {
    const result = await runFfmpeg([
      "-ss",
      String(Math.max(0, absStart)),
      "-i",
      videoPath,
      "-t",
      String(duration),
      "-vf",
      `select='gt(scene,${SCENE_CUT_THRESHOLD})',showinfo`,
      "-f",
      "null",
      "-",
    ]);
    stderr = result.stderr;
  } catch (err) {
    // Come detectSilences: -f null con select può comunque uscire con stderr popolato e
    // codice diverso da 0 in alcuni casi limite; recuperiamo lo stderr dall'errore se presente.
    const stderrFromError = (err as { stderr?: string }).stderr;
    if (!stderrFromError) throw err;
    stderr = stderrFromError;
  }

  const cuts: number[] = [];
  for (const match of stderr.matchAll(/pts_time:([\d.]+)/g)) {
    const t = Number.parseFloat(match[1]!);
    if (Number.isFinite(t)) cuts.push(t);
  }
  return cuts;
}
