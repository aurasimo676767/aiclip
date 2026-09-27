import type { TemplateName } from "./template.js";

export interface ZoomEvent {
  time: number;
  action: "zoom";
  /** Fattore di scala target, es. 1.10 = zoom 10%. */
  scale: number;
}

export interface PunchInEvent {
  time: number;
  action: "punch_in";
  scale: number;
}

export interface HighlightWordEvent {
  time: number;
  action: "highlight_word";
  word: string;
}

export interface SpeakerSwitchEvent {
  time: number;
  action: "speaker_switch";
  speaker: string;
}

export type EDLEvent = ZoomEvent | PunchInEvent | HighlightWordEvent | SpeakerSwitchEvent;

/**
 * Edit Decision List strutturata prodotta dall'AI per una singola clip.
 * Il renderer traduce ogni evento in filtri ffmpeg concreti (vedi apps/worker/src/render/edl-executor.ts).
 */
export interface EditDecisionList {
  template: TemplateName;
  events: EDLEvent[];
  /**
   * Titolo fisso in alto negli Shorts (3-6 parole, il gancio scritto): chi scorre capisce subito di
   * cosa si parla (simo, 2026-09-27: metà del pubblico scorreva via al primo secondo). Salvato
   * dentro l'EDL, che il render legge così com'è: nessuna migrazione.
   */
  headline?: string;
}
