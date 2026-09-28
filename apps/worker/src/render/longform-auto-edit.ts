import fsp from "node:fs/promises";
import path from "node:path";
import { runFfmpeg } from "../lib/ffmpeg.js";
import { logger } from "../lib/logger.js";
import type { CropWindow, FaceTracker } from "../face-tracking/face-tracker.js";
import { measureRmsWindows, WINDOW_SECONDS } from "./word-loudness.js";
import type { TranscriptSegment } from "@clipforge/shared";
import { planHighlights } from "../providers/ai/longform-highlights.js";
import { renderHeadlinePng, ensureHeadlineSfx } from "./headline.js";

/**
 * Montaggio automatico di un video long-form (opzionale, spento di default: vedi clips.longform_edit).
 * Due sole cose, come farebbe un montatore su una live:
 * - via i TEMPI MORTI: tratti in cui l'audio intero (voce E gioco) crolla molto sotto il livello
 *   abituale del video per qualche secondo. Una pausa normale o un momento di gioco silenzioso ma
 *   con l'audio del gioco acceso NON si tagliano: in un video lungo tagliare ogni pausa lo rende
 *   frenetico, e chi gioca concentrato in silenzio è comunque contenuto.
 * - STACCO SULLA FACCIA quando urlano: per un secondo e mezzo la webcam riempie lo schermo, poi si
 *   torna al gioco. La webcam è piccola nella live, quindi ingrandita è morbida (stile "meme",
 *   scelto da simo): un filtro di nitidezza la aiuta.
 *
 * Tutto in UNA passata ffmpeg senza split in pezzi (su un video di un'ora, dividere in centinaia di
 * rami con trim+concat terrebbe in memoria l'intero video): i tagli sono un select sulle finestre da
 * tenere, lo stacco è un overlay della webcam ingrandita attivato solo nei suoi tratti.
 */

/** Finestre audio su cui si decide (secondi). */
const BIN_SECONDS = 0.5;
/** Sotto il livello abituale di così, per MIN_DEAD_SECONDS di fila, è un tempo morto. */
const DEAD_BELOW_DB = 14;
const MIN_DEAD_SECONDS = 3;
/** Quanto silenzio lasciare ai lati di ogni taglio: senza, il taglio si sente come un colpo. */
const CUT_MARGIN_SECONDS = 0.4;
/** Sopra il livello abituale di così è un urlo (più severo che per gli Shorts: qui c'è l'audio del gioco). */
const SCREAM_ABOVE_DB = 8;
const MIN_SCREAM_SECONDS = 1;
/** Durata dello stacco sulla faccia e distanza minima fra due stacchi: oltre, stanca. */
const PUNCH_SECONDS = 1.6;
const MIN_PUNCH_SPACING_SECONDS = 45;
/** Da quanto prima dell'urlo guardare chi parla (il tracker ha bisogno di qualche secondo). */
const CAM_LOOK_BEFORE_SECONDS = 1.5;
/**
 * Quanto del riquadro webcam trovato tenere: il riquadro del tracker sborda spesso di qualche pixel
 * sul gioco attorno (a tutto schermo diventava una striscia blu sul bordo), e stringere sul centro
 * dà anche più effetto "zoom in faccia".
 */
const CAM_TIGHTEN = 0.84;

export interface TimeRange {
  start: number;
  end: number;
}

export interface LongformEditPlan {
  /** Tratti da tenere, in tempi del SEGMENTO (0 = inizio del video long-form). */
  keep: TimeRange[];
  /**
   * Stacchi sulla faccia: start/end in tempi del video MONTATO (dopo i tagli), sourceStart in tempi
   * del segmento originale (da dove leggere quel secondo e mezzo), ognuno con la SUA webcam.
   */
  punches: Array<TimeRange & { sourceStart: number; cam: CropWindow }>;
  removedSeconds: number;
  outputDuration: number;
  /** Momenti dell'intro "IN QUESTO VIDEO", in tempi del segmento (vuoto = nessuna intro). */
  intro: TimeRange[];
}

/** Montaggio "da YouTuber" con l'AI: serve la trascrizione del video (tempi del VOD) e il titolo. */
export interface HighlightsInput {
  title: string;
  segments: TranscriptSegment[];
  apiKey: string;
  model: string;
}

/** Tratto minimo tenuto e distanza sotto cui due tratti si uniscono (secondi). */
const MIN_KEEP_SECONDS = 5;
const MERGE_GAP_SECONDS = 4;
/** Intro: ogni momento fra 1,5 e 5 s, al massimo 3 momenti e circa 10 s in tutto (simo: "anche 10 secondi"). */
const INTRO_MIN_SECONDS = 1.5;
const INTRO_MAX_SECONDS = 5;
const INTRO_MAX_TOTAL_SECONDS = 10.5;

export async function planLongformEdit(params: {
  sourceVideoPath: string;
  sourceWidth: number;
  sourceHeight: number;
  start: number;
  end: number;
  faceTracker: FaceTracker;
  highlights?: HighlightsInput;
}): Promise<LongformEditPlan> {
  const duration = params.end - params.start;
  const bins = toBins(await measureRmsWindows(params.sourceVideoPath, params.start, duration));
  const audible = bins.filter((db) => db > -90);
  const baseline = audible.length > 0 ? median(audible) : -30;

  // Tempi morti -> tratti da tenere
  const dead = runsWhere(bins, (db) => db < baseline - DEAD_BELOW_DB, MIN_DEAD_SECONDS)
    .map((r) => ({ start: r.start + CUT_MARGIN_SECONDS, end: r.end - CUT_MARGIN_SECONDS }))
    .filter((r) => r.end - r.start >= 1);
  const keep: TimeRange[] = [];
  let cursor = 0;
  for (const d of dead) {
    if (d.start > cursor) keep.push({ start: cursor, end: d.start });
    cursor = d.end;
  }
  if (duration - cursor > 0.05) keep.push({ start: cursor, end: duration });

  // Montaggio da YouTuber: l'AI sceglie cosa tenere (un argomento solo, via le parti morte e le
  // divagazioni, fine quando smettono di giocare) e i momenti dell'intro. Dai suoi tratti si tolgono
  // comunque i silenzi veri trovati sopra. Se l'AI non risponde si resta al montaggio solo-silenzi.
  let intro: TimeRange[] = [];
  if (params.highlights) {
    const segments = params.highlights.segments
      .map((seg) => ({ ...seg, start: seg.start - params.start, end: seg.end - params.start }))
      .filter((seg) => seg.end > 0 && seg.start < duration);
    const loudMoments = runsWhere(bins, (db) => db >= baseline + SCREAM_ABOVE_DB, MIN_SCREAM_SECONDS, 1).map((r) => r.start);
    const aiPlan = await planHighlights(
      { title: params.highlights.title, durationSeconds: duration, segments, loudMoments },
      { apiKey: params.highlights.apiKey, model: params.highlights.model },
    );
    if (aiPlan) {
      const chosen = cleanRanges(aiPlan.keep, duration, segments);
      const chosenSeconds = chosen.reduce((sum, r) => sum + (r.end - r.start), 0);
      // Un piano che tiene meno di un minuto è quasi certamente sbagliato: meglio il video intero.
      if (chosenSeconds >= 60) {
        const merged = intersectRanges(keep, chosen).filter((r) => r.end - r.start >= 1);
        keep.splice(0, keep.length, ...merged);
        intro = cleanIntro(aiPlan.intro, keep);
      } else {
        logger.warn("Montaggio da YouTuber: piano troppo corto, resto al montaggio solo-silenzi", { tenutiSecondi: Math.round(chosenSeconds) });
      }
    }
  }
  const outputDuration = keep.reduce((sum, k) => sum + (k.end - k.start), 0);

  // Urla -> stacchi, i più forti per primi, distanziati, e solo dentro un tratto tenuto
  const screams = runsWhere(bins, (db) => db >= baseline + SCREAM_ABOVE_DB, MIN_SCREAM_SECONDS, 1)
    .map((r) => ({ ...r, strength: Math.max(...bins.slice(Math.floor(r.start / BIN_SECONDS), Math.ceil(r.end / BIN_SECONDS))) }))
    .sort((a, b) => b.strength - a.strength);
  const chosen: TimeRange[] = [];
  for (const s of screams) {
    const punch = { start: Math.max(0, s.start - 0.15), end: s.start - 0.15 + PUNCH_SECONDS };
    if (!keep.some((k) => punch.start >= k.start && punch.end <= k.end)) continue;
    if (chosen.some((c) => Math.abs(c.start - punch.start) < MIN_PUNCH_SPACING_SECONDS)) continue;
    chosen.push(punch);
  }
  chosen.sort((a, b) => a.start - b.start);

  // La webcam si cerca PER OGNI urlo, nei secondi dell'urlo: con più webcam (giochi di gruppo in
  // call) il tracker degli Shorts sceglie quella di chi sta parlando in quel momento. Con una sola
  // webcam fissa sarebbe bastata una ricerca, ma usando sempre la prima trovata lo stacco finiva
  // sulla faccia sbagliata (visto su skribbl con 5 webcam, 2026-09-25). Se in quel momento la scena
  // non ha una webcam (gioco a schermo intero), quello stacco salta.
  const withCam: Array<TimeRange & { cam: CropWindow }> = [];
  for (const p of chosen) {
    const cam = await findCamCrop({ ...params, from: params.start + p.start - CAM_LOOK_BEFORE_SECONDS, at: CAM_LOOK_BEFORE_SECONDS + 0.5 }).catch(
      (error) => {
        logger.warn("Ricerca webcam fallita per uno stacco", { error: error instanceof Error ? error.message : String(error) });
        return null;
      },
    );
    if (cam) withCam.push({ ...p, cam });
  }

  const toOutput = (t: number) => {
    let out = 0;
    for (const k of keep) {
      if (t >= k.end) out += k.end - k.start;
      else if (t >= k.start) return out + (t - k.start);
    }
    return out;
  };
  const punches = withCam.map((p) => ({ start: toOutput(p.start), end: toOutput(p.end), sourceStart: p.start, cam: p.cam }));

  logger.info("Montaggio automatico long-form", {
    livelloAbituale: baseline.toFixed(1),
    tagli: dead.length,
    tagliatiSecondi: Math.round(duration - outputDuration),
    stacchi: punches.length,
    webcamDiverse: new Set(punches.map((p) => camKey(p.cam))).size,
  });
  return { keep, punches, removedSeconds: duration - outputDuration, outputDuration, intro };
}

/**
 * Tratti dell'AI resi montabili: dentro il video, agganciati all'inizio e alla fine delle frasi
 * (mai un taglio a metà parola), uniti se vicini, scartati se cortissimi.
 */
function cleanRanges(ranges: TimeRange[], duration: number, segments: TranscriptSegment[]): TimeRange[] {
  const snapped = ranges
    .map((r) => {
      let start = Math.max(0, Math.min(r.start, r.end));
      let end = Math.min(duration, Math.max(r.start, r.end));
      const startSeg = segments.find((seg) => start > seg.start && start < seg.end);
      if (startSeg) start = startSeg.start;
      const endSeg = segments.find((seg) => end > seg.start && end < seg.end);
      if (endSeg) end = endSeg.end;
      return { start: Math.max(0, start - 0.2), end: Math.min(duration, end + 0.3) };
    })
    .filter((r) => r.end - r.start > 0.5)
    .sort((a, b) => a.start - b.start);
  const merged: TimeRange[] = [];
  for (const r of snapped) {
    const last = merged[merged.length - 1];
    if (last && r.start - last.end < MERGE_GAP_SECONDS) last.end = Math.max(last.end, r.end);
    else merged.push({ ...r });
  }
  return merged.filter((r) => r.end - r.start >= MIN_KEEP_SECONDS);
}

function intersectRanges(a: TimeRange[], b: TimeRange[]): TimeRange[] {
  const out: TimeRange[] = [];
  for (const x of a) {
    for (const y of b) {
      const start = Math.max(x.start, y.start);
      const end = Math.min(x.end, y.end);
      if (end > start) out.push({ start, end });
    }
  }
  return out.sort((p, q) => p.start - q.start);
}

/** Momenti dell'intro: corti, dentro i tratti tenuti, in ordine di tempo, al massimo ~10 s in tutto. */
function cleanIntro(ranges: TimeRange[], keep: TimeRange[]): TimeRange[] {
  const out: TimeRange[] = [];
  let total = 0;
  for (const r of ranges.slice(0, 3)) {
    const start = Math.min(r.start, r.end);
    let end = Math.min(Math.max(r.start, r.end), start + INTRO_MAX_SECONDS);
    const inside = keep.find((k) => start >= k.start - 0.5 && start < k.end);
    if (!inside) continue;
    end = Math.min(end, inside.end);
    if (end - start < INTRO_MIN_SECONDS || total + (end - start) > INTRO_MAX_TOTAL_SECONDS) continue;
    out.push({ start, end });
    total += end - start;
  }
  return out;
}

/** Renderizza il video montato secondo il piano, con la GPU (NVENC) e ripiego sulla CPU. */
export async function renderEditedLongform(params: {
  sourceVideoPath: string;
  start: number;
  end: number;
  plan: LongformEditPlan;
  workDir: string;
  outputPath: string;
}): Promise<void> {
  const { plan } = params;
  const between = (ranges: TimeRange[]) => ranges.map((r) => `between(t,${r.start.toFixed(3)},${r.end.toFixed(3)})`).join("+");
  const keepExpr = between(plan.keep);

  // Ogni stacco è un INGRESSO a parte che legge solo il suo secondo e mezzo di sorgente, ingrandisce
  // la webcam e viene sovrapposto al video montato dal suo istante in poi. Prima un ramo per webcam
  // ingrandiva TUTTI i fotogrammi del video anche fuori dagli stacchi: con 5 webcam, 5 volte il
  // lavoro (10 minuti di video non finivano in 9 minuti di render).
  const last = plan.punches.length;
  const hasIntro = plan.intro.length > 0;
  const mainV = hasIntro ? "vmain" : "vout";
  const steps = [`[0:v]select='${keepExpr}',setpts=N/FRAME_RATE/TB,scale=1920:1080:flags=lanczos,setsar=1[${last === 0 ? mainV : "l0"}]`];
  plan.punches.forEach((p, i) => {
    const c = p.cam;
    steps.push(
      `[${i + 1}:v]crop=${c.width}:${c.height}:${c.x}:${c.y},scale=1920:1080:flags=lanczos,unsharp=5:5:0.9:5:5:0.0,setsar=1,setpts=PTS-STARTPTS+${p.start.toFixed(3)}/TB[p${i}]`,
      `[l${i}][p${i}]overlay=0:0:eof_action=pass[${i === last - 1 ? mainV : `l${i + 1}`}]`,
    );
  });
  const introInputs: string[] = [];
  if (!hasIntro) {
    steps.push(`[0:a]aselect='${keepExpr}',asetpts=N/SR/TB,loudnorm=I=-14:TP=-1.5:LRA=11,aresample=44100[aout]`);
  } else {
    // Intro "IN QUESTO VIDEO": i momenti scelti (ognuno un ingresso a parte), la scritta bianca
    // grande in basso al centro che entra con un pop, il whoosh; poi il video montato. Il volume
    // si normalizza una volta sola sul risultato finale.
    steps.push(`[0:a]aselect='${keepExpr}',asetpts=N/SR/TB,aresample=44100[amain]`);
    const base = plan.punches.length + 1;
    const introDuration = plan.intro.reduce((sum, r) => sum + (r.end - r.start), 0);
    plan.intro.forEach((r, i) => {
      introInputs.push("-ss", (params.start + r.start).toFixed(3), "-t", (r.end - r.start).toFixed(3), "-i", params.sourceVideoPath);
      steps.push(
        `[${base + i}:v]scale=1920:1080:flags=lanczos,setsar=1,setpts=PTS-STARTPTS[iv${i}]`,
        `[${base + i}:a]aresample=44100,asetpts=PTS-STARTPTS[ia${i}]`,
      );
    });
    const n = plan.intro.length;
    steps.push(`${plan.intro.map((_, i) => `[iv${i}][ia${i}]`).join("")}concat=n=${n}:v=1:a=1[introv][introa]`);
    let introV = "introv";
    let introA = "introa";
    const textPath = path.join(params.workDir, "in-questo-video.png");
    const text = await renderHeadlinePng("IN QUESTO VIDEO", textPath, { allWhite: true, baseSize: 150, maxWidth: 1500 });
    let nextInput = base + n;
    if (text) {
      introInputs.push("-loop", "1", "-t", introDuration.toFixed(3), "-i", textPath);
      const sExpr = "if(lt(t,0.12),0.9+1.83*t,if(lt(t,0.25),1.12-0.92*(t-0.12),1))";
      steps.push(
        `[${nextInput}:v]format=rgba,scale=w='max(2,trunc(${text.width}*${sExpr}/2)*2)':h=-2:eval=frame[qv]`,
        `[introv][qv]overlay=x='(W-w)/2':y='H-h-90':eval=frame:shortest=1[introvt]`,
      );
      introV = "introvt";
      nextInput++;
    }
    const sfx = await ensureHeadlineSfx((a) => runFfmpeg(a));
    if (sfx) {
      introInputs.push("-i", sfx);
      steps.push(`[introa][${nextInput}:a]amix=inputs=2:duration=first:dropout_transition=0:normalize=0[introas]`);
      introA = "introas";
    }
    steps.push(
      `[${introV}][${introA}][vmain][amain]concat=n=2:v=1:a=1[vcat][acat]`,
      "[vcat]null[vout]",
      "[acat]loudnorm=I=-14:TP=-1.5:LRA=11,aresample=44100[aout]",
    );
  }

  // Lo script su file: con centinaia di tagli la riga di comando supererebbe il limite di Windows.
  const scriptPath = path.join(params.workDir, "edit-filter.txt");
  await fsp.writeFile(scriptPath, steps.join(";\n"), "utf8");

  const punchInputs = plan.punches.flatMap((p) => ["-ss", (params.start + p.sourceStart).toFixed(3), "-t", (p.end - p.start).toFixed(3), "-i", params.sourceVideoPath]);
  const input = [
    "-y",
    "-ss",
    String(params.start),
    "-to",
    String(params.end),
    "-i",
    params.sourceVideoPath,
    ...punchInputs,
    ...introInputs,
    "-/filter_complex",
    scriptPath,
    "-map",
    "[vout]",
    "-map",
    "[aout]",
  ];
  const audio = ["-c:a", "aac", "-b:a", "192k", "-ac", "2"];
  const tail = ["-movflags", "+faststart", params.outputPath];
  // Tetto generoso: codificare con la GPU sta molto sotto il tempo reale, con la CPU circa a metà.
  const timeoutMs = Math.max(20 * 60, (params.end - params.start) * 1.5) * 1000;

  try {
    await runFfmpeg(
      [...input, "-c:v", "h264_nvenc", "-preset", "p5", "-rc", "vbr", "-cq", "21", "-b:v", "0", "-maxrate", "20M", "-bufsize", "40M", "-pix_fmt", "yuv420p", ...audio, ...tail],
      { timeoutMs },
    );
  } catch (error) {
    logger.warn("Codifica con la GPU fallita, riprovo con la CPU", { error: error instanceof Error ? error.message.slice(-300) : String(error) });
    await runFfmpeg([...input, "-c:v", "libx264", "-preset", "veryfast", "-crf", "20", "-pix_fmt", "yuv420p", ...audio, ...tail], { timeoutMs: timeoutMs * 2 });
  }
}

/** Da finestre di 50ms a finestre di BIN_SECONDS, media in potenza (non in dB). */
function toBins(levels: number[]): number[] {
  const per = Math.round(BIN_SECONDS / WINDOW_SECONDS);
  const bins: number[] = [];
  for (let i = 0; i < levels.length; i += per) {
    const slice = levels.slice(i, i + per);
    const power = slice.reduce((sum, db) => sum + Math.pow(10, db / 10), 0) / slice.length;
    bins.push(power > 0 ? 10 * Math.log10(power) : -100);
  }
  return bins;
}

/** Tratti continui (in secondi) di finestre che rispettano la condizione, lunghi almeno minSeconds; buchi fino a mergeGap bin si ignorano. */
function runsWhere(bins: number[], test: (db: number) => boolean, minSeconds: number, mergeGap = 0): TimeRange[] {
  const runs: TimeRange[] = [];
  let startBin = -1;
  let lastHit = -1;
  for (let i = 0; i <= bins.length; i++) {
    const hit = i < bins.length && test(bins[i]!);
    if (hit) {
      if (startBin < 0) startBin = i;
      lastHit = i;
    } else if (startBin >= 0 && i - lastHit > mergeGap) {
      runs.push({ start: startBin * BIN_SECONDS, end: (lastHit + 1) * BIN_SECONDS });
      startBin = -1;
    }
  }
  return runs.filter((r) => r.end - r.start >= minSeconds);
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)]!;
}

/**
 * Ritaglio 16:9 della webcam, cercata col tracker degli Shorts in una finestra di 12 secondi. Se la
 * webcam è più "quadrata" del 16:9 si tagliano sopra e sotto (mai allargare: si prenderebbe il
 * gioco attorno), centrando sul riquadro trovato.
 */
async function findCamCrop(params: {
  sourceVideoPath: string;
  sourceWidth: number;
  sourceHeight: number;
  faceTracker: FaceTracker;
  /** Inizio della finestra analizzata (secondi nel sorgente). */
  from: number;
  /** Istante dell'urlo, in secondi dall'inizio della finestra: vince la webcam attiva lì. */
  at: number;
}): Promise<CropWindow | null> {
  const from = Math.max(0, params.from);
  const layout = await params.faceTracker.computeLayout({
    sourceVideoPath: params.sourceVideoPath,
    sourceWidth: params.sourceWidth,
    sourceHeight: params.sourceHeight,
    startSeconds: from,
    endSeconds: from + params.at + PUNCH_SECONDS,
    sceneCuts: false,
  });
  let cam: CropWindow | undefined;
  if (layout.type === "split_vertical") {
    cam = (layout.topCrops.find((c) => params.at >= c.startSeconds && params.at < c.endSeconds) ?? layout.topCrops[0])?.crop;
  } else {
    const scene = layout.scenes.find((s) => params.at >= s.startSeconds && params.at < s.endSeconds);
    if (scene?.composition.kind === "split") cam = scene.composition.cam;
  }
  if (!cam) return null;

  let width = cam.width * CAM_TIGHTEN;
  let height = (width * 9) / 16;
  if (height > cam.height * CAM_TIGHTEN) {
    height = cam.height * CAM_TIGHTEN;
    width = (height * 16) / 9;
  }
  const even = (n: number) => Math.max(2, Math.floor(n / 2) * 2);
  width = even(width);
  height = even(height);
  const x = Math.round(Math.min(params.sourceWidth - width, Math.max(0, cam.x + cam.width / 2 - width / 2)));
  const y = Math.round(Math.min(params.sourceHeight - height, Math.max(0, cam.y + cam.height / 2 - height / 2)));
  return { x, y, width, height };
}

function camKey(c: CropWindow): string {
  return `${c.x},${c.y},${c.width},${c.height}`;
}
