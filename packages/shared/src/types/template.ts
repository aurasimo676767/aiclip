export const TEMPLATE_NAMES = [
  "PODCAST_DYNAMIC",
  "PODCAST_CLEAN",
  "STREAMER",
  "STORYTELLING",
  "MOTIVATIONAL",
] as const;

export type TemplateName = (typeof TEMPLATE_NAMES)[number];

// "smart": non una posizione fissa — il renderer sceglie riga per riga in base al layout del
// momento (vicino al confine webcam/contenuto durante uno split_vertical, altrimenti la
// posizione di default) invece di stare sempre nella stessa fascia per tutta la clip. Vedi
// apps/worker/src/render/captions.ts.
export type CaptionPosition = "top" | "center" | "bottom" | "smart";

export interface CaptionStyleConfig {
  fontFamily: string;
  fontSize: number;
  position: CaptionPosition;
  /** Colore testo primario, formato hex #RRGGBB. */
  textColor: string;
  /** Colore usato per evidenziare la parola attiva (karaoke/word highlight). */
  highlightColor: string;
  /** Colore del contorno/ombra del testo per leggibilità su qualsiasi sfondo. */
  outlineColor: string;
  /** Mostra le parole una alla volta (karaoke) invece di intere frasi. */
  wordByWord: boolean;
  /**
   * Una SOLA parola visibile alla volta (sostituita dalla successiva), invece di un gruppo di
   * più parole con sweep karaoke — stile "TikTok/reaction" richiesto esplicitamente dopo aver
   * visto due Shorts di riferimento. Ha effetto solo se wordByWord è true.
   */
  oneWordAtATime: boolean;
  uppercase: boolean;
}

export interface TemplateConfig {
  name: TemplateName;
  label: string;
  description: string;
  captionStyle: CaptionStyleConfig;
  /** Moltiplicatore di intensità per gli eventi di zoom generati/interpretati dall'AI (0 = disattivato, 1 = normale, >1 = più aggressivo). */
  zoomIntensity: number;
  /** Mostra una progress bar in basso che indica l'avanzamento della clip. */
  showProgressBar: boolean;
  /** Rimuove automaticamente le pause/silenzi superiori alla soglia (secondi). null = disattivato. */
  silenceRemovalThresholdSeconds: number | null;
}

/**
 * UNO stile di sottotitoli per tutti gli Shorts, qualunque template: una parola alla volta, Arial
 * Bold maiuscolo (quello che simo vuole: "deve essere come quello di prima", e prima era Arial
 * perché i font chiesti dai template non erano installati). I template restano diversi solo in
 * zoom e taglio dei silenzi. Serve anche perché "Rigenera" cambia template a ogni giro: con stili
 * diversi per template una clip rigenerata passava ai sottotitoli a frase, su due righe.
 */
export const SHORTS_CAPTION_STYLE: CaptionStyleConfig = {
  fontFamily: "Arial",
  fontSize: 124,
  position: "smart",
  textColor: "#FFFFFF",
  highlightColor: "#FFD400",
  outlineColor: "#000000",
  wordByWord: true,
  oneWordAtATime: true,
  uppercase: true,
};

export const DEFAULT_TEMPLATES: Record<TemplateName, TemplateConfig> = {
  PODCAST_DYNAMIC: {
    name: "PODCAST_DYNAMIC",
    label: "Podcast Dynamic",
    description: "Sottotitoli word-by-word, zoom frequenti, alta energia. Ideale per estratti podcast/interviste.",
    captionStyle: SHORTS_CAPTION_STYLE,
    zoomIntensity: 1.2,
    showProgressBar: true,
    silenceRemovalThresholdSeconds: 0.6,
  },
  PODCAST_CLEAN: {
    name: "PODCAST_CLEAN",
    label: "Podcast Clean",
    description: "Editing minimale: zoom leggeri, pause tagliate con moderazione.",
    captionStyle: SHORTS_CAPTION_STYLE,
    zoomIntensity: 0.4,
    showProgressBar: false,
    silenceRemovalThresholdSeconds: 1.0,
  },
  STREAMER: {
    name: "STREAMER",
    label: "Streamer",
    description: "Stile gaming/streaming: caption grandi e colorate, zoom aggressivi.",
    captionStyle: SHORTS_CAPTION_STYLE,
    zoomIntensity: 1.5,
    showProgressBar: true,
    silenceRemovalThresholdSeconds: 0.5,
  },
  STORYTELLING: {
    name: "STORYTELLING",
    label: "Storytelling",
    description: "Ritmo più lento, zoom morbidi per momenti narrativi/emotivi.",
    captionStyle: SHORTS_CAPTION_STYLE,
    zoomIntensity: 0.6,
    showProgressBar: false,
    silenceRemovalThresholdSeconds: 1.2,
  },
  MOTIVATIONAL: {
    name: "MOTIVATIONAL",
    label: "Motivational",
    description: "Forte enfasi sulle parole chiave, zoom marcati sui payoff.",
    captionStyle: SHORTS_CAPTION_STYLE,
    zoomIntensity: 1.3,
    showProgressBar: true,
    silenceRemovalThresholdSeconds: 0.6,
  },
};
