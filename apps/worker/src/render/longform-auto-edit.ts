import fsp from "node:fs/promises";
import path from "node:path";
import { exactSeekInput, exactSeekTrim, FFmpegCancelledError, runFfmpeg, seekPreroll } from "../lib/ffmpeg.js";
import { logger } from "../lib/logger.js";
import type { CropWindow } from "../face-tracking/face-tracker.js";
import { measureRmsWindows, WINDOW_SECONDS } from "./word-loudness.js";
import type { TranscriptSegment } from "@clipforge/shared";
import { planHighlights, tightenHighlights } from "../providers/ai/longform-highlights.js";
import { PhraseLocator, type LocatedPhrase } from "./intro-moments.js";
import { allowedRanges, type GameSegment } from "../providers/ai/game-timeline.js";
import type { HighlightsPlan } from "../providers/ai/longform-highlights.js";
import { renderHeadlinePng, ensureHeadlineSfx } from "./headline.js";
import { findSpeakingWebcam, sameWebcam, scoreWebcamSpeakers, type StreamWebcam, type WebcamSpeakers } from "../face-tracking/closeup-cams.js";
import { voiceGroups } from "../face-tracking/voice-check.js";
import { describePhases, detectMatchPhases, gameShare } from "../providers/ai/match-phases.js";
import { enforceMatchStructure } from "./match-structure.js";
import { BANNER_BOTTOM_MARGIN } from "./subscribe-banner.js";
import { ensureTransitionSfx, HEAD_SECONDS, TAIL_SECONDS, transitionFilters } from "./opening-transition.js";

/**
 * Montaggio automatico di un video long-form (opzionale, spento di default: vedi clips.longform_edit).
 * Due sole cose, come farebbe un montatore su una live:
 * - via i TEMPI MORTI: tratti in cui l'audio intero (voce E gioco) crolla molto sotto il livello
 *   abituale del video per qualche secondo. Una pausa normale o un momento di gioco silenzioso ma
 *   con l'audio del gioco acceso NON si tagliano: in un video lungo tagliare ogni pausa lo rende
 *   frenetico, e chi gioca concentrato in silenzio è comunque contenuto.
 * - PRIMO PIANO quando qualcuno reagisce forte: per un paio di secondi l'inquadratura stringe sulla
 *   webcam di chi parla, poi si torna al gioco. La webcam si vede INTERA e ai lati resta quello che
 *   c'è davvero attorno (gioco, schermo), come una telecamera che stringe: niente sfondi finti (simo,
 *   2026-10-26: "almeno non risulta IA"). La webcam è piccola nella live, quindi ingrandita è morbida
 *   (stile "meme", scelto da simo): un filtro di nitidezza la aiuta.
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
/** Aria attorno alla webcam nel primo piano: senza, il bordo dell'inserto coincide col bordo dello schermo e sembra un ritaglio. */
const CAM_ZOOM_MARGIN = 1.04;
/**
 * Primo piano a schermo pieno, solo la webcam (simo, 2026-10-26: "se viene omogeneo, dove si vede
 * bene e non troppo schifoso"): riquadro vero, alto almeno FULL_MIN_HEIGHT_RATIO dello schermo (al
 * massimo ~3 volte ingrandito) e che riempiendo lo schermo perde al massimo 1 - FULL_MIN_SHARE di sé.
 */
const FULL_MIN_HEIGHT_RATIO = 0.3;
const FULL_MIN_SHARE = 0.85;

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
  /**
   * Frase d'apertura dello streamer dopo l'intro (tempi del segmento), con lo zoom sulla sua webcam
   * (null = a schermo intero), seguita dalla transizione verso l'inizio del gioco.
   */
  opening?: TimeRange & { cam: CropWindow | null };
}

/** Montaggio "da YouTuber" con l'AI: serve la trascrizione del video (tempi del VOD) e il titolo. */
export interface HighlightsInput {
  title: string;
  segments: TranscriptSegment[];
  apiKey: string;
  model: string;
  /** Modello che guarda lo schermo per le fasi delle partite (match-phases.ts); assente = montaggio senza fasi. */
  phaseModel?: string;
  /** Per ritrascrivere con Whisper i pochi secondi dei momenti dell'intro (vedi intro-moments.ts). */
  openaiApiKey: string;
  /** Giochi riconosciuti dallo schermo e quali tenere (vedi game-timeline.ts): tagli precisi al fotogramma. */
  games?: { timeline: GameSegment[]; keep: string[] };
}

/** Lunghezza dei pezzi che il secondo giro giudica uno per uno (i tratti più lunghi si spezzano). */
const TIGHTEN_PIECE_SECONDS = 90;

/** Spezza i tratti più lunghi di `maxSeconds` in pezzi di circa quella lunghezza, tagliando tra una frase e l'altra. */
function splitLongRanges(ranges: Array<{ start: number; end: number }>, segments: Array<{ start: number; end: number }>, maxSeconds: number): Array<{ start: number; end: number }> {
  const out: Array<{ start: number; end: number }> = [];
  for (const r of ranges) {
    let start = r.start;
    while (r.end - start > maxSeconds * 1.5) {
      const ideal = start + maxSeconds;
      // Il confine di frase più vicino al punto ideale (fine di una frase dentro il tratto).
      const cut = segments
        .map((seg) => seg.end)
        .filter((t) => t > start + maxSeconds * 0.5 && t < r.end - maxSeconds * 0.5)
        .reduce((best, t) => (Math.abs(t - ideal) < Math.abs(best - ideal) ? t : best), ideal);
      out.push({ start, end: cut });
      start = cut;
    }
    out.push({ start, end: r.end });
  }
  return out;
}
/** Sul cambio di gioco: se il pezzo tenuto prima finisce al massimo così tanto prima, lo si allunga fino al cambio. */
const TOPIC_EXTEND_SECONDS = 90;
/**
 * Zoom sulla webcam, rifatti il 2026-11-05 (simo: "zoomma poco, e nei momenti dove a volte stanno
 * muti, e in momenti a caso, voglio che zoomi di più, ma con senso, in affermazioni, battute,
 * scleri, urla... DEVE ESSERE LUI CHE FA L'AZIONE"). Nel montato di Dub Together l'AI ne proponeva 4
 * (solo urla) e ne restava 1 in 17 minuti. Ora: scleri, risate, battute e affermazioni forti, sulle
 * parole esatte ritrovate nell'audio (quindi qualcuno sta parlando davvero), da poco prima della prima
 * parola a poco dopo l'ultima, a 8 s l'uno dall'altro al minimo; nei conflitti vince prima lo sclero,
 * poi la risata, la battuta, l'affermazione. Niente soglia sul volume: sopra l'audio del gioco un
 * insulto urlato e una frase piatta misuravano uguale (2026-10-26). Chi inquadrare lo decide il
 * modello chi-parla, e solo se è sicuro (closeup-cams.ts).
 */
const ZOOM_MIN_SECONDS = 1.3;
const ZOOM_MAX_SECONDS = 4.5;
const ZOOM_SPACING_SECONDS = 8;
// Niente zoom sulle sole risate (simo, 2026-11-06): "risata" resta solo per leggere i piani vecchi.
const ZOOM_PRIORITY: Record<string, number> = { sclero: 0, battuta: 1, affermazione: 2 };
/** Dopo l'ultima parola: una risata o uno sclero hanno bisogno di qualche decimo in più per chiudersi. */
const ZOOM_TAIL_SECONDS: Record<string, number> = { sclero: 0.6, risata: 0.9, battuta: 0.5, affermazione: 0.5 };

/** Sotto questa quota di tempo passato a giocare (partita, inizio, fine) le regole delle partite non valgono. */
const MIN_GAME_SHARE = 0.25;

/** Tratto minimo tenuto e distanza sotto cui due tratti si uniscono (secondi). */
const MIN_KEEP_SECONDS = 5;
const MERGE_GAP_SECONDS = 4;
/** Intro: ogni momento fra 1,5 e 5 s, al massimo 3 momenti e circa 10 s in tutto (simo: "anche 10 secondi"). */
const INTRO_MIN_SECONDS = 1.5;
const INTRO_MAX_SECONDS = 5;
/** Reaction: la frase del video più la loro reazione, quindi momenti un po' più lunghi. */
const REACTION_INTRO_MAX_SECONDS = 6;
const REACTION_INTRO_MAX_TOTAL_SECONDS = 12;
const INTRO_MAX_TOTAL_SECONDS = 10.5;

export async function planLongformEdit(params: {
  sourceVideoPath: string;
  sourceWidth: number;
  sourceHeight: number;
  start: number;
  end: number;
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
  // comunque i silenzi veri trovati sopra. Se l'AI non risponde (dopo un secondo tentativo) il render fallisce.
  let intro: TimeRange[] = [];
  // Primi piani scelti dall'AI sulle parole (null = nessun piano AI: stacchi sulle urla come prima).
  let aiCloseups: TimeRange[] | null = null;
  // Frase d'apertura ritrovata nell'audio (la webcam di chi la dice si cerca più sotto).
  let openingRange: TimeRange | null = null;
  if (params.highlights) {
    // Con i giochi riconosciuti dallo schermo si tengono solo le parti dei giochi scelti da simo:
    // all'AI arriva solo la loro trascrizione, e i tagli sui cambi di gioco sono quelli dei fotogrammi.
    const games = params.highlights.games;
    const allowed = games ? allowedRanges(games.timeline, games.keep) : null;
    const byScreen = allowed && allowed.reduce((sum, r) => sum + (r.end - r.start), 0) >= 60 ? allowed : null;
    if (games && !byScreen) logger.warn("Giochi scelti troppo corti o assenti nella mappa: montaggio senza filtro per gioco", { keep: games.keep });
    const segments = params.highlights.segments
      .map((seg) => ({ ...seg, start: seg.start - params.start, end: seg.end - params.start }))
      .filter((seg) => seg.end > 0 && seg.start < duration)
      .filter((seg) => !byScreen || byScreen.some((r) => seg.end > r.start && seg.start < r.end));
    const loudMoments = runsWhere(bins, (db) => db >= baseline + SCREAM_ABOVE_DB, MIN_SCREAM_SECONDS, 1).map((r) => r.start);
    const hl = params.highlights;
    // Reaction (dal titolo, o nessun gioco a schermo): l'intro mostra i momenti del VIDEO a cui
    // reagiscono, con la loro reazione (simo, 2026-09-28: "è una reaction, avrebbe gasato come clip
    // iniziale le clip del video a cui stanno reagendo").
    const isReaction = /reaction|reagisc|reazion/i.test(hl.title) || (!!games && !games.timeline.some((g) => g.kind === "gioco"));
    // Cosa c'è a schermo (partita, inizio, fine, menu...), solo nei tratti del gioco tenuto: serve al
    // montaggio per tenere le partite e accorciare i menu (vedi match-phases.ts e match-structure.ts).
    // Mai nelle reaction né dove si gioca poco (Just Chatting): lì a schermo c'è il video o la webcam,
    // "altro" per la mappa, e la regola sui menu brevi li taglierebbe a pezzi.
    const screenPhases =
      hl.phaseModel && !isReaction
        ? await detectMatchPhases(
            { sourceVideoPath: params.sourceVideoPath, start: params.start, end: params.end, ranges: byScreen ?? [{ start: 0, end: duration }] },
            { apiKey: hl.apiKey, model: hl.phaseModel },
          )
        : null;
    const phases = screenPhases && gameShare(screenPhases) >= MIN_GAME_SHARE ? screenPhases : null;
    if (screenPhases && !phases) logger.info("Fasi a schermo: si gioca poco, montaggio senza regole delle partite", { giocato: gameShare(screenPhases).toFixed(2) });
    const notes = [
      byScreen
        ? `Le parti in cui fanno altro (altri giochi, chiacchiere) sono già state tolte guardando lo schermo: dove i tempi saltano c'era altro. Resta solo: ${games!.keep.join(", ")}. Non servono cambi di argomento (topicChanges vuoto).`
        : null,
      isReaction
        ? "È una REACTION: guardano un video e ci reagiscono. Per l'INTRO scegli i momenti più forti DEL VIDEO a cui reagiscono (la frase o la scena più assurda detta nel video), con la loro reazione subito dopo: in una reaction è questo che fa venire voglia di guardare. In \"quote\" metti le parole esatte dette NEL VIDEO. Qui la regola \"SOLO URLA\" dell'intro non vale."
        : null,
    ].filter(Boolean);
    const askPlan = () =>
      planHighlights(
        {
          title: hl.title,
          durationSeconds: duration,
          segments,
          loudMoments,
          note: notes.length > 0 ? notes.join("\n\n") : undefined,
          screen: phases ? describePhases(phases) : undefined,
        },
        { apiKey: hl.apiKey, model: hl.model },
      );
    // Un piano che non arriva si riprova una volta; se manca ancora il render fallisce: un "montato"
    // senza tagli né intro è peggio di un errore (simo, 2026-09-28, video su Ale della Giusta:
    // "non ha montato mi sa, stessa durata, e non ha aggiunto IN QUESTO VIDEO").
    let aiPlan = await askPlan();
    if (!aiPlan) {
      logger.warn("Montaggio da YouTuber: piano non arrivato, riprovo una volta");
      aiPlan = await askPlan();
    }
    if (!aiPlan) throw new Error("Montaggio AI non riuscito due volte: premi di nuovo Rigenera clip (il motivo è nel log del worker)");
    {
      let chosen = cleanRanges(aiPlan.keep, duration, segments);
      if (byScreen) chosen = intersectRanges(chosen, byScreen).filter((r) => r.end - r.start >= 1);
      const seconds = (rs: TimeRange[]) => rs.reduce((sum, r) => sum + (r.end - r.start), 0);
      // Un piano che tiene meno di un minuto è quasi certamente sbagliato: meglio il video intero.
      if (seconds(chosen) >= 60) {
        const locator = new PhraseLocator({
          segments,
          sourceVideoPath: params.sourceVideoPath,
          clipStart: params.start,
          clipDuration: duration,
          openaiApiKey: params.highlights.openaiApiKey,
        });
        try {
          // Dallo schermo i cambi di gioco sono già esatti; senza, si cercano le parole del cambio.
          if (!byScreen) chosen = (await applyTopicChanges(chosen, aiPlan.topicChanges, locator, duration)).ranges;
          // Secondo giro sempre, senza durata obiettivo: via tutti i pezzi deboli (vedi tightenHighlights).
          {
            // Pezzi lunghi spezzati sui confini delle frasi: se l'AI tiene tratti attaccati (Family
            // Feud, 2026-10-02: 35 tratti diventati 1-2 blocchi da un'ora) il secondo giro non aveva
            // niente da scegliere e non partiva nemmeno.
            const pieces = splitLongRanges(chosen, segments, TIGHTEN_PIECE_SECONDS).map((r) => ({
              ...r,
              text: segments.filter((seg) => seg.end > r.start && seg.start < r.end).map((seg) => seg.text).join(" "),
            }));
            const tightened = await tightenHighlights(
              {
                title: params.highlights.title,
                pieces,
                // Solo i momenti dell'intro: proteggere anche le righe degli zoom (150 su un torneo) bloccava quasi ogni taglio.
                protect: aiPlan.intro.map((r) => ({ start: r.start, end: r.end })),
                sourceSeconds: duration,
              },
              { apiKey: params.highlights.apiKey, model: params.highlights.model },
            );
            if (tightened && seconds(tightened) >= 60) chosen = tightened;
          }
          // Struttura garantita dal codice: inizio e fine di ogni partita tenuta, ogni gioco presente,
          // menu brevi, presentazione corta (match-structure.ts). Va dopo il secondo giro, che a pezzi
          // da 90 s può togliere proprio la fine di una partita.
          if (phases) {
            const strong = [...aiPlan.intro, ...aiPlan.closeups].map((r) => ({ start: r.start, end: r.end }));
            const structured = enforceMatchStructure({ keep: chosen, phases, segments, duration, strong });
            logger.info("Montaggio: struttura delle partite", { esito: structured.note });
            chosen = byScreen ? intersectRanges(structured.keep, byScreen).filter((r) => r.end - r.start >= 1) : structured.keep;
          }
          const merged = intersectRanges(keep, chosen).filter((r) => r.end - r.start >= 1);
          keep.splice(0, keep.length, ...merged);
          // Frase d'apertura dopo l'intro, poi il video riparte da dove comincia il gioco.
          openingRange = await locateOpening(aiPlan, locator, duration);
          if (openingRange) {
            const from = Math.max(openingRange.end, aiPlan.gameStart ?? openingRange.end);
            const dropped = keep.reduce((sum, k) => sum + Math.max(0, Math.min(k.end, from) - k.start), 0);
            // Un inizio del gioco troppo avanti è quasi certamente sbagliato: lì si salta solo la frase.
            const to = from <= Math.min(duration * 0.3, 600) && dropped <= MAX_SKIPPED_TO_GAME_SECONDS ? from : openingRange.end;
            const trimmed = keep.map((k) => ({ start: Math.max(k.start, to), end: k.end })).filter((k) => k.end - k.start >= 1);
            keep.splice(0, keep.length, ...trimmed);
            logger.info("Frase d'apertura e inizio del gioco", { frase: `${openingRange.start.toFixed(1)}-${openingRange.end.toFixed(1)}`, riparteDa: to.toFixed(1), saltati: Math.round(dropped) });
          }
          const located: LocatedPhrase[] = [];
          for (const c of aiPlan.intro) {
            const f = await locator.locate(c);
            if (!f) continue;
            const start = Math.max(0, f.start - 0.5);
            // Reaction: dopo la frase del video servono un paio di secondi della loro reazione.
            const tail = isReaction ? 2.5 : 1.2;
            const max = isReaction ? REACTION_INTRO_MAX_SECONDS : INTRO_MAX_SECONDS;
            located.push({ ...f, start, end: Math.min(duration, Math.max(start + 2, Math.min(f.end + tail, start + max))) });
          }
          intro = isReaction
            ? pickIntro(located, chosen, REACTION_INTRO_MAX_SECONDS, REACTION_INTRO_MAX_TOTAL_SECONDS)
            : pickIntro(located, chosen);
          aiCloseups = await locateCloseups(aiPlan.closeups, locator, keep, duration);
          // L'intro c'è SEMPRE (simo): se nessuna frase dell'intro si trova nell'audio, si usano i
          // primi piani già collocati sulle parole (sclero e frasi forti), i due più corti.
          if (intro.length === 0 && aiCloseups.length > 0) {
            intro = [...aiCloseups]
              .sort((a, b) => a.end - a.start - (b.end - b.start))
              .slice(0, 2)
              .map((r) => ({ start: r.start, end: Math.min(r.end, r.start + INTRO_MAX_SECONDS) }))
              .sort((a, b) => a.start - b.start);
            logger.warn("Intro: nessuna frase trovata, uso i primi piani", { intro: intro.map((r) => r.start.toFixed(1)) });
          }
        } finally {
          await locator.dispose();
        }
      } else {
        throw new Error(`Montaggio AI sbagliato (tiene solo ${Math.round(seconds(chosen))} s): premi di nuovo Rigenera clip`);
      }
    }
  }
  const outputDuration = keep.reduce((sum, k) => sum + (k.end - k.start), 0);

  // Urla -> stacchi, i più forti per primi, distanziati, e solo dentro un tratto tenuto
  const screams = runsWhere(bins, (db) => db >= baseline + SCREAM_ABOVE_DB, MIN_SCREAM_SECONDS, 1)
    .map((r) => ({ ...r, strength: Math.max(...bins.slice(Math.floor(r.start / BIN_SECONDS), Math.ceil(r.end / BIN_SECONDS))) }))
    .sort((a, b) => b.strength - a.strength);
  const chosen: TimeRange[] = aiCloseups ? [...aiCloseups] : [];
  for (const s of aiCloseups ? [] : screams) {
    const punch = { start: Math.max(0, s.start - 0.15), end: s.start - 0.15 + PUNCH_SECONDS };
    if (!keep.some((k) => punch.start >= k.start && punch.end <= k.end)) continue;
    if (chosen.some((c) => Math.abs(c.start - punch.start) < MIN_PUNCH_SPACING_SECONDS)) continue;
    chosen.push(punch);
  }
  chosen.sort((a, b) => a.start - b.start);

  // Per ogni primo piano: le webcam di quel momento e chi parla proprio lì (vedi closeup-cams.ts).
  // Usando sempre la prima webcam trovata lo stacco finiva sulla faccia sbagliata (skribbl con 5
  // webcam, 2026-09-25); col layout degli Shorts finiva sul proprietario o su riquadri con dentro
  // mezzo gioco (Switch Sports, 2026-10-26). Se non si capisce chi parla, quel primo piano salta:
  // meglio nessuno che uno sbagliato.
  const fail = (what: string) => (error: unknown) => {
    logger.warn(what, { error: error instanceof Error ? error.message : String(error) });
    return null;
  };
  const withCam = (await assignZoomCams(chosen, params, fail)).map((z) => ({ ...z, cam: closeupWindow(z.webcam, params.sourceWidth, params.sourceHeight) }));

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
  // Zoom della frase d'apertura su chi la dice, con le stesse regole degli altri zoom; se non è
  // sicuro di chi parla, la frase resta a schermo intero.
  let opening: LongformEditPlan["opening"];
  if (openingRange) {
    const found = await findSpeakingWebcam({
      videoPath: params.sourceVideoPath,
      width: params.sourceWidth,
      height: params.sourceHeight,
      from: params.start + Math.max(0, openingRange.start - CAM_LOOK_BEFORE_SECONDS),
      to: params.start + openingRange.end + 0.5,
      focusFrom: params.start + openingRange.start,
      focusTo: params.start + openingRange.end,
    }).catch(fail("Ricerca di chi dice la frase d'apertura fallita"));
    opening = { ...openingRange, cam: found ? closeupWindow(found, params.sourceWidth, params.sourceHeight) : null };
    logger.info("Frase d'apertura", { zoom: found ? camKey(opening.cam!) : "schermo intero" });
  }

  return { keep, punches, removedSeconds: duration - outputDuration, outputDuration, intro, opening };
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

/**
 * I 2 momenti dell'intro fra quelli collocati sulle parole: i più forti, a più di 20 s l'uno
 * dall'altro, al massimo ~10 s in tutto, mostrati in ordine di tempo. Prima quelli dentro i pezzi
 * tenuti (si rivedono nel video), poi, se mancano, anche gli altri.
 */
function pickIntro(
  located: LocatedPhrase[],
  chosen: TimeRange[],
  maxLen = INTRO_MAX_SECONDS,
  maxTotal = INTRO_MAX_TOTAL_SECONDS,
): TimeRange[] {
  const inside = (m: TimeRange) => chosen.some((c) => m.start >= c.start - 1 && m.start < c.end);
  const ranked = [...located].sort((a, b) => Number(inside(b)) - Number(inside(a)) || b.loudness - a.loudness);
  const out: TimeRange[] = [];
  let total = 0;
  for (const m of ranked) {
    if (out.length >= 2) break;
    const len = Math.min(m.end - m.start, maxLen);
    if (len < INTRO_MIN_SECONDS || total + len > maxTotal) continue;
    if (out.some((o) => m.start < o.end + 20 && m.start + len > o.start - 20)) continue;
    out.push({ start: m.start, end: m.start + len });
    total += len;
  }
  return out.sort((a, b) => a.start - b.start);
}

/** Renderizza il video montato secondo il piano, con la GPU (NVENC) e ripiego sulla CPU. */
export async function renderEditedLongform(params: RenderEditedParams): Promise<void> {
  const parts = splitForRender(params);
  if (parts.length <= 1) return renderEditedPart(params);
  // A pezzi (simo, 2026-11-08: "Cannot allocate memory" su ogni montato da 2 ore in su): ogni zoom è
  // un ingresso che apre il sorgente, e con 62-198 zoom in un solo ffmpeg la memoria finiva. Ogni
  // pezzo ha al massimo MAX_ZOOMS_PER_PART zoom e MAX_PART_SECONDS di video; poi si uniscono senza
  // ricodificare (stessa codifica per tutti).
  logger.info("Montato renderizzato a pezzi", { pezzi: parts.length, zoom: params.plan.punches.length });
  const files: string[] = [];
  for (const [i, part] of parts.entries()) {
    const out = path.join(params.workDir, `part-${i}.mp4`);
    const dir = path.join(params.workDir, `part-${i}`);
    await fsp.mkdir(dir, { recursive: true });
    await renderEditedPart({ ...part, workDir: dir, outputPath: out });
    files.push(out);
  }
  const list = path.join(params.workDir, "parts.ffconcat");
  await fsp.writeFile(list, `ffconcat version 1.0\n${files.map((f) => `file '${path.resolve(f).replace(/\\/g, "/").replace(/'/g, "'\\''")}'\n`).join("")}`);
  await runFfmpeg(["-y", "-f", "concat", "-safe", "0", "-i", list, "-c", "copy", "-movflags", "+faststart", params.outputPath], { timeoutMs: 30 * 60 * 1000 });
  for (const f of files) await fsp.rm(f, { force: true }).catch(() => undefined);
}

interface RenderEditedParams {
  sourceVideoPath: string;
  start: number;
  end: number;
  plan: LongformEditPlan;
  workDir: string;
  outputPath: string;
  /** Banner "iscriviti" (video con trasparenza, vedi subscribe-banner.ts) e quando farlo comparire (secondi del video finale). */
  banner?: { path: string; times: number[]; sfx?: string | null };
}

const MAX_ZOOMS_PER_PART = 25;
const MAX_PART_SECONDS = 15 * 60;

/**
 * Il montato diviso in pezzi consecutivi, tagliati fra un tratto tenuto e l'altro. Il primo pezzo ha
 * intro e frase d'apertura; ogni pezzo ha i suoi zoom e banner, coi tempi spostati al suo inizio. Ogni
 * pezzo si apre dal sorgente al suo primo tratto (start), e i tempi del segmento si spostano di tanto.
 */
function splitForRender(params: RenderEditedParams): RenderEditedParams[] {
  const { plan } = params;
  const prefix = plan.intro.reduce((s, r) => s + (r.end - r.start), 0) + (plan.opening ? plan.opening.end - plan.opening.start : 0);
  const groups: TimeRange[][] = [];
  let current: TimeRange[] = [];
  let currentOut = 0;
  let cursor = 0;
  let zoomsInCurrent = 0;
  for (const k of plan.keep) {
    const len = k.end - k.start;
    const zooms = plan.punches.filter((p) => p.start >= cursor && p.start < cursor + len).length;
    if (current.length > 0 && (currentOut + len > MAX_PART_SECONDS || zoomsInCurrent + zooms > MAX_ZOOMS_PER_PART)) {
      groups.push(current);
      current = [];
      currentOut = 0;
      zoomsInCurrent = 0;
    }
    current.push(k);
    currentOut += len;
    zoomsInCurrent += zooms;
    cursor += len;
  }
  if (current.length > 0) groups.push(current);
  if (groups.length <= 1) return [params];

  const parts: RenderEditedParams[] = [];
  let outStart = 0;
  groups.forEach((g, i) => {
    const outLen = g.reduce((s, r) => s + (r.end - r.start), 0);
    const shift = g[0]!.start;
    const at = (t: number) => t - shift;
    const punches = plan.punches
      .filter((p) => p.start >= outStart && p.start < outStart + outLen)
      .map((p) => ({ ...p, start: p.start - outStart, end: Math.min(p.end, outStart + outLen) - outStart, sourceStart: at(p.sourceStart) }));
    // Tempi del video finale coperti dal pezzo (il primo comprende intro e frase d'apertura).
    const finalFrom = i === 0 ? 0 : prefix + outStart;
    const finalTo = prefix + outStart + outLen;
    const times = (params.banner?.times ?? []).filter((t) => t >= finalFrom && t < finalTo).map((t) => t - finalFrom);
    parts.push({
      ...params,
      start: params.start + shift,
      end: params.start + g[g.length - 1]!.end,
      plan: {
        ...plan,
        keep: g.map((r) => ({ start: at(r.start), end: at(r.end) })),
        punches,
        intro: i === 0 ? plan.intro.map((r) => ({ start: at(r.start), end: at(r.end) })) : [],
        opening: i === 0 && plan.opening ? { ...plan.opening, start: at(plan.opening.start), end: at(plan.opening.end) } : undefined,
        outputDuration: outLen,
      },
      banner: params.banner && times.length > 0 ? { ...params.banner, times } : undefined,
    });
    outStart += outLen;
  });
  return parts;
}

async function renderEditedPart(params: RenderEditedParams): Promise<void> {
  const { plan } = params;
  const banners = params.banner?.times ?? [];
  const between = (ranges: TimeRange[]) => ranges.map((r) => `between(t,${r.start.toFixed(3)},${r.end.toFixed(3)})`).join("+");
  // Il sorgente si apre SEEK_PREROLL_SECONDS prima (vedi exactSeekInput): i tratti si spostano di tanto.
  const pre = seekPreroll(params.start);
  const keepExpr = between(plan.keep.map((r) => ({ start: r.start + pre, end: r.end + pre })));

  // Ogni stacco è un INGRESSO a parte che legge solo il suo secondo e mezzo di sorgente, ingrandisce
  // la webcam e viene sovrapposto al video montato dal suo istante in poi. Prima un ramo per webcam
  // ingrandiva TUTTI i fotogrammi del video anche fuori dagli stacchi: con 5 webcam, 5 volte il
  // lavoro (10 minuti di video non finivano in 9 minuti di render).
  const last = plan.punches.length;
  const hasIntro = plan.intro.length > 0;
  const opening = plan.opening && plan.opening.end - plan.opening.start > TAIL_SECONDS + 0.5 ? plan.opening : undefined;
  const hasPrefix = hasIntro || !!opening;
  // Col banner, l'uscita del montaggio passa ancora dalle sovrapposizioni del banner prima di [vout].
  const outV = banners.length > 0 ? "vedit" : "vout";
  const mainV = hasPrefix ? "vmain" : outV;
  const steps = [`[0:v]select='${keepExpr}',setpts=N/FRAME_RATE/TB,scale=1920:1080:flags=lanczos,setsar=1[${last === 0 ? mainV : "l0"}]`];
  plan.punches.forEach((p, i) => {
    const c = p.cam;
    steps.push(
      `[${i + 1}:v]${exactSeekTrim(params.start + p.sourceStart, p.end - p.start, "v")},crop=${c.width}:${c.height}:${c.x}:${c.y},scale=1920:1080:flags=lanczos,unsharp=5:5:0.9:5:5:0.0,setsar=1,setpts=PTS+${p.start.toFixed(3)}/TB[p${i}]`,
      `[l${i}][p${i}]overlay=0:0:eof_action=pass[${i === last - 1 ? mainV : `l${i + 1}`}]`,
    );
  });
  const introInputs: string[] = [];
  if (!hasPrefix) {
    steps.push(`[0:a]aselect='${keepExpr}',asetpts=N/SR/TB,loudnorm=I=-14:TP=-1.5:LRA=11,aresample=44100[aout]`);
  } else {
    // Prima del video montato: l'intro "IN QUESTO VIDEO" (se c'è) e la frase d'apertura con la
    // transizione. Video e audio si uniscono separatamente: la transizione taglia in due la coda
    // della frase e la testa del montato solo nel video.
    steps.push(`[0:a]aselect='${keepExpr}',asetpts=N/SR/TB,aresample=44100[amain]`);
    const videoParts: string[] = [];
    const audioParts: string[] = [];
    let nextInput = plan.punches.length + 1;
    let prefixSeconds = 0;
    if (hasIntro) {
      const intro = await introSteps(params, nextInput, steps, introInputs);
      nextInput = intro.nextInput;
      videoParts.push(intro.video);
      audioParts.push(intro.audio);
      prefixSeconds += intro.seconds;
    }
    let transitionAt: number | null = null;
    if (opening) {
      const seconds = opening.end - opening.start;
      const { tail, head } = transitionFilters();
      const c = opening.cam;
      const zoom = c ? `crop=${c.width}:${c.height}:${c.x}:${c.y},scale=1920:1080:flags=lanczos,unsharp=5:5:0.9:5:5:0.0` : "scale=1920:1080:flags=lanczos";
      const openAt = params.start + opening.start;
      introInputs.push("-threads", "1", ...exactSeekInput(params.sourceVideoPath, openAt, seconds));
      const body = (seconds - TAIL_SECONDS).toFixed(3);
      steps.push(
        `[${nextInput}:v]${exactSeekTrim(openAt, seconds, "v")},${zoom},setsar=1,split=2[ob][ot]`,
        `[ob]trim=0:${body},setpts=PTS-STARTPTS[obv]`,
        `[ot]trim=${body}:${seconds.toFixed(3)},setpts=PTS-STARTPTS,${tail},setsar=1[otv]`,
        `[${nextInput}:a]${exactSeekTrim(openAt, seconds, "a")},aresample=44100[oa]`,
        `[vmain]split=2[mh][mb]`,
        `[mh]trim=0:${HEAD_SECONDS},setpts=PTS-STARTPTS,${head},setsar=1[mhv]`,
        `[mb]trim=${HEAD_SECONDS},setpts=PTS-STARTPTS[mbv]`,
      );
      nextInput++;
      videoParts.push("[obv]", "[otv]");
      audioParts.push("[oa]");
      transitionAt = prefixSeconds + seconds - TAIL_SECONDS;
      prefixSeconds += seconds;
      videoParts.push("[mhv]", "[mbv]");
    } else {
      videoParts.push("[vmain]");
    }
    audioParts.push("[amain]");
    steps.push(`${videoParts.join("")}concat=n=${videoParts.length}:v=1:a=0[${outV}]`, `${audioParts.join("")}concat=n=${audioParts.length}:v=0:a=1[acat]`);
    const whoosh = transitionAt !== null ? await ensureTransitionSfx() : null;
    if (whoosh && transitionAt !== null) {
      introInputs.push("-i", whoosh);
      const ms = Math.max(0, Math.round((transitionAt - 0.05) * 1000));
      steps.push(`[${nextInput}:a]aresample=44100,adelay=${ms}|${ms}[tsfx]`, "[acat][tsfx]amix=inputs=2:duration=first:dropout_transition=0:normalize=0[acatx]");
      nextInput++;
      steps.push("[acatx]loudnorm=I=-14:TP=-1.5:LRA=11,aresample=44100[aout]");
    } else {
      steps.push("[acat]loudnorm=I=-14:TP=-1.5:LRA=11,aresample=44100[aout]");
    }
  }
  const bannerInputs: string[] = [];
  if (banners.length > 0) {
    const first = plan.punches.length + 1 + inputCount(introInputs);
    banners.forEach((t, i) => {
      bannerInputs.push("-i", params.banner!.path);
      const from = i === 0 ? outV : `vb${i}`;
      const to = i === banners.length - 1 ? "vout" : `vb${i + 1}`;
      steps.push(
        `[${first + i}:v]setpts=PTS-STARTPTS+${t.toFixed(3)}/TB[bn${i}]`,
        `[${from}][bn${i}]overlay=x=(W-w)/2:y=H-h-${BANNER_BOTTOM_MARGIN}:eof_action=pass[${to}]`,
      );
    });
  }

  // Suono del banner: un ingresso per comparsa, spostato al suo istante e mescolato sotto l'audio finale.
  const sfx = params.banner?.sfx;
  if (banners.length > 0 && sfx) {
    const first = plan.punches.length + 1 + inputCount(introInputs) + banners.length;
    const finalA = steps.findIndex((st) => st.endsWith("[aout]"));
    steps[finalA] = steps[finalA]!.replace(/\[aout\]$/, "[amain0]");
    banners.forEach((t, i) => {
      bannerInputs.push("-i", sfx);
      const ms = Math.round(t * 1000);
      steps.push(`[${first + i}:a]aresample=44100,adelay=${ms}|${ms}[bs${i}]`);
    });
    const labels = banners.map((_, i) => `[bs${i}]`).join("");
    steps.push(`[amain0]${labels}amix=inputs=${banners.length + 1}:duration=first:dropout_transition=0:normalize=0[aout]`);
  }

  // Lo script su file: con centinaia di tagli la riga di comando supererebbe il limite di Windows.
  const scriptPath = path.join(params.workDir, "edit-filter.txt");
  await fsp.writeFile(scriptPath, steps.join(";\n"), "utf8");

  // Un thread a testa per i pezzetti (2-8 s): con il decoder a thread automatici (20 sul PC di simo)
  // 49 ingressi dello stesso VOD hanno finito la memoria e ucciso il worker (Affari Tuoi, 2026-10-25).
  const punchInputs = plan.punches.flatMap((p) => ["-threads", "1", ...exactSeekInput(params.sourceVideoPath, params.start + p.sourceStart, p.end - p.start)]);
  const input = [
    "-y",
    ...exactSeekInput(params.sourceVideoPath, params.start, params.end - params.start),
    ...punchInputs,
    ...introInputs,
    ...bannerInputs,
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
    if (error instanceof FFmpegCancelledError) throw error;
    logger.warn("Codifica con la GPU fallita, riprovo con la CPU", { error: error instanceof Error ? error.message.slice(-300) : String(error) });
    await runFfmpeg([...input, "-c:v", "libx264", "-preset", "veryfast", "-crf", "20", "-pix_fmt", "yuv420p", ...audio, ...tail], { timeoutMs: timeoutMs * 2 });
  }
}

/**
 * Intro "IN QUESTO VIDEO": i momenti scelti (ognuno un ingresso a parte), la scritta bianca grande in
 * basso al centro che entra con un pop, il whoosh. Restituisce le etichette del suo video e audio.
 */
async function introSteps(
  params: { sourceVideoPath: string; start: number; plan: LongformEditPlan; workDir: string },
  base: number,
  steps: string[],
  inputs: string[],
): Promise<{ video: string; audio: string; seconds: number; nextInput: number }> {
  const { plan } = params;
  const seconds = plan.intro.reduce((sum, r) => sum + (r.end - r.start), 0);
  plan.intro.forEach((r, i) => {
    const at = params.start + r.start;
    inputs.push("-threads", "1", ...exactSeekInput(params.sourceVideoPath, at, r.end - r.start));
    steps.push(
      `[${base + i}:v]${exactSeekTrim(at, r.end - r.start, "v")},scale=1920:1080:flags=lanczos,setsar=1[iv${i}]`,
      `[${base + i}:a]${exactSeekTrim(at, r.end - r.start, "a")},aresample=44100[ia${i}]`,
    );
  });
  const n = plan.intro.length;
  steps.push(`${plan.intro.map((_, i) => `[iv${i}][ia${i}]`).join("")}concat=n=${n}:v=1:a=1[introv][introa]`);
  let video = "[introv]";
  let audio = "[introa]";
  let nextInput = base + n;
  const textPath = path.join(params.workDir, "in-questo-video.png");
  const text = await renderHeadlinePng("IN QUESTO VIDEO", textPath, { allWhite: true, baseSize: 150, maxWidth: 1500 });
  if (text) {
    inputs.push("-loop", "1", "-t", seconds.toFixed(3), "-i", textPath);
    const sExpr = "if(lt(t,0.12),0.9+1.83*t,if(lt(t,0.25),1.12-0.92*(t-0.12),1))";
    steps.push(
      `[${nextInput}:v]format=rgba,scale=w='max(2,trunc(${text.width}*${sExpr}/2)*2)':h=-2:eval=frame[qv]`,
      `[introv][qv]overlay=x='(W-w)/2':y='H-h-90':eval=frame:shortest=1[introvt]`,
    );
    video = "[introvt]";
    nextInput++;
  }
  const sfx = await ensureHeadlineSfx((a) => runFfmpeg(a));
  if (sfx) {
    inputs.push("-i", sfx);
    steps.push(`[introa][${nextInput}:a]amix=inputs=2:duration=first:dropout_transition=0:normalize=0[introas]`);
    audio = "[introas]";
    nextInput++;
  }
  return { video, audio, seconds, nextInput };
}

/** Quanti ingressi (-i) ci sono in una lista di argomenti ffmpeg. */
function inputCount(args: string[]): number {
  return args.filter((a) => a === "-i").length;
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
 * Inquadratura del primo piano: a schermo pieno solo la webcam quando ingrandita viene bene (vedi
 * FULL_MIN_*), altrimenti la webcam intera col gioco vero attorno (zoomWindow).
 */
export function closeupWindow(cam: StreamWebcam, sourceWidth: number, sourceHeight: number): CropWindow {
  const r = cam.rect;
  const width = Math.min(r.width, (r.height * 16) / 9);
  const height = (width * 9) / 16;
  const share = (width * height) / (r.width * r.height);
  if (cam.estimated || share < FULL_MIN_SHARE || height < sourceHeight * FULL_MIN_HEIGHT_RATIO) return zoomWindow(r, sourceWidth, sourceHeight);
  const even = (n: number) => Math.max(2, Math.floor(n / 2) * 2);
  const w = even(width);
  const h = even(height);
  return { x: Math.round(r.x + (r.width - w) / 2), y: Math.round(r.y + (r.height - h) / 2), width: w, height: h };
}

/**
 * La finestra 16:9 più stretta che contiene TUTTA la webcam (con un filo d'aria), centrata su di lei
 * e spostata solo quanto serve a restare dentro lo schermo. Una webcam più "quadrata" del 16:9 lascia
 * ai lati il gioco o lo schermo che le sta davvero accanto (simo, 2026-10-26: niente riempimento
 * sfocato, "almeno non risulta IA"); prima si tagliavano sopra e sotto e le teste uscivano.
 */
export function zoomWindow(cam: CropWindow, sourceWidth: number, sourceHeight: number): CropWindow {
  let width = Math.max(cam.width, (cam.height * 16) / 9) * CAM_ZOOM_MARGIN;
  let height = (width * 9) / 16;
  if (width > sourceWidth) {
    width = sourceWidth;
    height = (width * 9) / 16;
  }
  if (height > sourceHeight) {
    height = sourceHeight;
    width = (height * 16) / 9;
  }
  const even = (n: number) => Math.max(2, Math.floor(n / 2) * 2);
  width = even(width);
  height = even(height);
  const x = Math.round(Math.min(sourceWidth - width, Math.max(0, cam.x + cam.width / 2 - width / 2)));
  const y = Math.round(Math.min(sourceHeight - height, Math.max(0, cam.y + cam.height / 2 - height / 2)));
  return { x, y, width, height };
}

function camKey(c: CropWindow): string {
  return `${c.x},${c.y},${c.width},${c.height}`;
}

/**
 * Taglio preciso sui cambi di argomento (simo, 2026-09-28, video di COD: "ha tagliato ancora che
 * stavano in partita su cod, invece doveva tagliare nel momento dove cambiavano gioco"). Si cercano
 * nell'audio le parole con cui lasciano il gioco e quelle con cui ci tornano: quel pezzo si toglie,
 * e il tratto tenuto subito prima si allunga fino al cambio se finiva poco prima.
 */
async function applyTopicChanges(
  chosen: TimeRange[],
  changes: HighlightsPlan["topicChanges"],
  locator: PhraseLocator,
  duration: number,
): Promise<{ ranges: TimeRange[]; removedSeconds: number }> {
  let out = chosen.map((r) => ({ ...r }));
  let removedSeconds = 0;
  for (const c of changes) {
    const leave = await locator.locate({ start: c.leaveAt, end: c.leaveAt + 30, quote: c.leaveQuote });
    if (!leave) continue;
    const back = c.returnQuote.trim() ? await locator.locate({ start: c.returnAt, end: c.returnAt + 30, quote: c.returnQuote }) : null;
    const cutStart = Math.max(0, leave.start - 0.3);
    // Frase del rientro non trovata nell'audio: si torna alla riga indicata dall'AI, NON "non tornano
    // più". Il 2026-09-28 (Ale della Giusta) quel caso tagliava da 27 minuti alla fine, e il video
    // montato usciva di 10 minuti. Anche quando non tornano davvero, il taglio si ferma al primo
    // pezzo che l'AI stessa ha deciso di tenere dopo l'uscita.
    const nextKept = out.find((r) => r.start > cutStart + 1)?.start;
    const cutEnd = back
      ? Math.max(cutStart, back.start - 0.3)
      : c.returnQuote.trim()
        ? Math.max(cutStart, c.returnAt)
        : Math.min(duration, nextKept ?? duration);
    removedSeconds += cutEnd - cutStart;
    const before = out.filter((r) => r.end <= cutStart + 1).at(-1);
    if (before && cutStart - before.end <= TOPIC_EXTEND_SECONDS) before.end = Math.max(before.end, cutStart);
    const after = back ? out.find((r) => r.start >= cutEnd - 1) : undefined;
    if (after && after.start - cutEnd <= TOPIC_EXTEND_SECONDS) after.start = Math.min(after.start, cutEnd);
    out = out.flatMap((r) => {
      if (r.end <= cutStart || r.start >= cutEnd) return [r];
      const parts: TimeRange[] = [];
      if (r.start < cutStart) parts.push({ start: r.start, end: cutStart });
      if (r.end > cutEnd) parts.push({ start: cutEnd, end: r.end });
      return parts;
    });
    logger.info("Cambio di argomento tagliato sulle parole", { da: cutStart.toFixed(1), a: cutEnd.toFixed(1), esce: c.leaveQuote, torna: back ? c.returnQuote : null });
  }
  return { ranges: out.filter((r) => r.end - r.start >= 1), removedSeconds };
}

/**
 * A chi va ogni zoom: a chi ha DETTO la frase, non a chi muove la bocca (simo, 2026-11-06, Mimic
 * Party: "quelli su Pesh un po' meno... solo la risata così no, negli ultimi è quasi in silenzio"). Il
 * modello chi-parla guarda se una bocca si muove a tempo con l'audio, e chi ride mentre parla un altro
 * lo inganna. Qui le frasi si raggruppano per VOCE (voice-check.ts) e ogni voce va alla webcam che il
 * modello indica di più sulle sue frasi; lo zoom va su quella webcam solo se in quel momento la sua
 * faccia si vede e la sua bocca non è ferma. Senza voce (nessuno parla davvero) o con una voce che non
 * è di nessuna webcam (chi è in call senza camera, il gioco), niente zoom. Una voce sentita una volta
 * sola vale solo se il modello da solo era sicuro.
 */
async function assignZoomCams(
  zooms: TimeRange[],
  params: { sourceVideoPath: string; sourceWidth: number; sourceHeight: number; start: number },
  fail: (what: string) => (error: unknown) => null,
): Promise<Array<TimeRange & { webcam: StreamWebcam }>> {
  const scored: Array<WebcamSpeakers | null> = [];
  for (const p of zooms) {
    scored.push(
      await scoreWebcamSpeakers({
        videoPath: params.sourceVideoPath,
        width: params.sourceWidth,
        height: params.sourceHeight,
        from: params.start + Math.max(0, p.start - CAM_LOOK_BEFORE_SECONDS),
        to: params.start + p.end + 0.5,
        focusFrom: params.start + p.start,
        focusTo: params.start + p.end,
      }).catch(fail("Ricerca di chi parla fallita per uno zoom")),
    );
  }
  // Le webcam di tutti i momenti in un elenco solo (i riquadri cambiano di poco da un momento all'altro).
  const all: CropWindow[] = [];
  const globalIndex = (rect: CropWindow) => {
    const k = all.findIndex((r) => sameWebcam(r, rect));
    if (k >= 0) return k;
    all.push(rect);
    return all.length - 1;
  };
  const local = scored.map((s) => (s ? s.cams.map((c) => globalIndex(c.rect)) : []));
  const voices = await voiceGroups(
    params.sourceVideoPath,
    zooms.map((p) => ({ start: params.start + p.start, end: params.start + p.end })),
  ).catch((error) => {
    fail("Raggruppamento per voce fallito: zoom solo col modello chi-parla")(error);
    return null;
  });

  // Ogni voce alla webcam col punteggio medio più alto sulle sue frasi.
  const voiceOwner = new Map<number, number | null>();
  for (const v of new Set((voices ?? []).filter((x) => x >= 0))) {
    const members = zooms.map((_, i) => i).filter((i) => voices![i] === v && scored[i]);
    const sums = new Map<number, { sum: number; n: number }>();
    for (const i of members) {
      scored[i]!.means.forEach((m, k) => {
        if (!Number.isFinite(m)) return;
        const g = local[i]![k]!;
        const acc = sums.get(g) ?? { sum: 0, n: 0 };
        sums.set(g, { sum: acc.sum + m, n: acc.n + 1 });
      });
    }
    const ranked = [...sums.entries()].map(([g, a]) => ({ g, avg: a.sum / a.n })).sort((a, b) => b.avg - a.avg);
    const top = ranked[0];
    const single = members.length === 1 ? scored[members[0]!] : null;
    const owner = top && top.avg >= VOICE_MIN_MEAN && (!single || (single.ok && local[members[0]!]![single.best] === top.g)) ? top.g : null;
    voiceOwner.set(v, owner);
  }

  const out: Array<TimeRange & { webcam: StreamWebcam }> = [];
  zooms.forEach((p, i) => {
    const s = scored[i];
    if (!s) return;
    let k: number;
    if (!voices) {
      if (!s.ok) return;
      k = s.best;
    } else {
      const owner = voices[i]! >= 0 ? voiceOwner.get(voices[i]!) : null;
      if (owner === null || owner === undefined) return;
      k = local[i]!.indexOf(owner);
      // La webcam di quella voce deve esserci, con la faccia visibile e la bocca che si muove.
      if (k < 0 || !s.visible[k] || !(s.means[k]! > 0)) return;
    }
    out.push({ ...p, webcam: s.cams[k]! });
  });
  logger.info("Zoom assegnati per voce", {
    zoom: zooms.map((p, i) => `${p.start.toFixed(1)}:voce${voices?.[i] ?? "?"}→${out.some((o) => o.start === p.start) ? `webcam${voices && voices[i]! >= 0 ? voiceOwner.get(voices[i]!) : "?"}` : "niente"}`).join(" "),
    webcam: all.map((r, g) => `${g}=${r.x},${r.y}`).join(" "),
  });
  return out;
}

/** Punteggio medio minimo del modello chi-parla sulle frasi di una voce perché sia di quella webcam. */
const VOICE_MIN_MEAN = 0.5;

/** Dalla frase d'apertura all'inizio del gioco si saltano al massimo tanti secondi di video tenuto. */
const MAX_SKIPPED_TO_GAME_SECONDS = 180;
/** La frase d'apertura dura fra queste due misure (secondi). */
const OPENING_MIN_SECONDS = 1.2;
const OPENING_MAX_SECONDS = 7;

/**
 * La frase d'apertura sulle parole vere: un attimo prima della prima parola fino a poco dopo
 * l'ultima. Solo nella prima parte del pezzo (deve lanciare il video, non stare a metà).
 */
async function locateOpening(plan: HighlightsPlan, locator: PhraseLocator, duration: number): Promise<TimeRange | null> {
  const o = plan.opening;
  if (!o || o.start > Math.min(duration * 0.3, 600)) return null;
  const f = await locator.locate(o);
  if (!f) return null;
  const start = Math.max(0, f.start - 0.3);
  const end = Math.min(duration, start + OPENING_MAX_SECONDS, f.end + 0.45);
  return end - start >= OPENING_MIN_SECONDS ? { start, end } : null;
}

/**
 * Zoom dell'AI messi sulle parole vere (vedi ZOOM_*): ogni candidato si ritrova nell'audio (se le
 * parole non ci sono, niente zoom: è il caso dei "momenti in cui stanno muti"), resta dentro un
 * tratto tenuto, e fra due vicini vince il più forte.
 */
async function locateCloseups(
  closeups: HighlightsPlan["closeups"],
  locator: PhraseLocator,
  keep: TimeRange[],
  duration: number,
): Promise<TimeRange[]> {
  const candidates: Array<TimeRange & { priority: number; loudness: number }> = [];
  for (const c of closeups) {
    const priority = ZOOM_PRIORITY[c.kind];
    if (priority === undefined) continue;
    const f = await locator.locate(c);
    if (!f) continue;
    const start = Math.max(0, f.start - 0.25);
    const k = keep.find((r) => start >= r.start && start < r.end);
    if (!k) continue;
    const end = Math.min(k.end, duration, Math.max(start + ZOOM_MIN_SECONDS, Math.min(f.end + (ZOOM_TAIL_SECONDS[c.kind] ?? 0.5), start + ZOOM_MAX_SECONDS)));
    if (end - start < 1) continue;
    candidates.push({ start, end, priority, loudness: f.loudness });
  }
  const out: TimeRange[] = [];
  for (const c of candidates.sort((a, b) => a.priority - b.priority || b.loudness - a.loudness)) {
    if (out.some((o) => c.start < o.end + ZOOM_SPACING_SECONDS && c.end > o.start - ZOOM_SPACING_SECONDS)) continue;
    out.push({ start: c.start, end: c.end });
  }
  logger.info("Zoom dell'AI collocati", { proposti: closeups.length, trovatiNellAudio: candidates.length, messi: out.length });
  return out.sort((a, b) => a.start - b.start);
}
