export const TEMPLATE_NAMES = [
  "PODCAST_DYNAMIC",
  "PODCAST_CLEAN",
  "STREAMER",
  "STORYTELLING",
  "MOTIVATIONAL",
] as const;

export type TemplateName = (typeof TEMPLATE_NAMES)[number];

export type CaptionPosition = "top" | "center" | "bottom";

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
  uppercase: boolean;
}

export interface TemplateConfig {
  name: TemplateName;
  label: string;
  description: string;
  captionStyle: CaptionStyleConfig;
  /** Moltiplicatore di intensità per gli eventi di zoom generati/interpretati dall'AI (0 = disattivato, 1 = normale, >1 = più aggressivo). */
  zoomIntensity: number;
  /** Mostra un breve testo hook sovraimpresso nei primi secondi della clip. */
  showHookText: boolean;
  /** Mostra una progress bar in basso che indica l'avanzamento della clip. */
  showProgressBar: boolean;
  /** Rimuove automaticamente le pause/silenzi superiori alla soglia (secondi). null = disattivato. */
  silenceRemovalThresholdSeconds: number | null;
}

export const DEFAULT_TEMPLATES: Record<TemplateName, TemplateConfig> = {
  PODCAST_DYNAMIC: {
    name: "PODCAST_DYNAMIC",
    label: "Podcast Dynamic",
    description: "Sottotitoli word-by-word, zoom frequenti, alta energia. Ideale per estratti podcast/interviste.",
    captionStyle: {
      fontFamily: "Montserrat ExtraBold",
      fontSize: 72,
      position: "center",
      textColor: "#FFFFFF",
      highlightColor: "#FFD400",
      outlineColor: "#000000",
      wordByWord: true,
      uppercase: true,
    },
    zoomIntensity: 1.2,
    showHookText: true,
    showProgressBar: true,
    silenceRemovalThresholdSeconds: 0.6,
  },
  PODCAST_CLEAN: {
    name: "PODCAST_CLEAN",
    label: "Podcast Clean",
    description: "Sottotitoli a frase, editing minimale, tono professionale.",
    captionStyle: {
      fontFamily: "Inter SemiBold",
      fontSize: 60,
      position: "bottom",
      textColor: "#FFFFFF",
      highlightColor: "#FFFFFF",
      outlineColor: "#000000",
      wordByWord: false,
      uppercase: false,
    },
    zoomIntensity: 0.4,
    showHookText: false,
    showProgressBar: false,
    silenceRemovalThresholdSeconds: 1.0,
  },
  STREAMER: {
    name: "STREAMER",
    label: "Streamer",
    description: "Stile gaming/streaming: caption grandi e colorate, zoom aggressivi.",
    captionStyle: {
      fontFamily: "Poppins Black",
      fontSize: 78,
      position: "center",
      textColor: "#FFFFFF",
      highlightColor: "#00E5FF",
      outlineColor: "#000000",
      wordByWord: true,
      uppercase: true,
    },
    zoomIntensity: 1.5,
    showHookText: true,
    showProgressBar: true,
    silenceRemovalThresholdSeconds: 0.5,
  },
  STORYTELLING: {
    name: "STORYTELLING",
    label: "Storytelling",
    description: "Ritmo più lento, caption a frase, zoom morbidi per momenti narrativi/emotivi.",
    captionStyle: {
      fontFamily: "Merriweather Bold",
      fontSize: 58,
      position: "bottom",
      textColor: "#FFFFFF",
      highlightColor: "#FFD400",
      outlineColor: "#000000",
      wordByWord: false,
      uppercase: false,
    },
    zoomIntensity: 0.6,
    showHookText: true,
    showProgressBar: false,
    silenceRemovalThresholdSeconds: 1.2,
  },
  MOTIVATIONAL: {
    name: "MOTIVATIONAL",
    label: "Motivational",
    description: "Caption bold centrali, forte enfasi sulle parole chiave, zoom marcati sui payoff.",
    captionStyle: {
      fontFamily: "Anton",
      fontSize: 80,
      position: "center",
      textColor: "#FFFFFF",
      highlightColor: "#FF3B30",
      outlineColor: "#000000",
      wordByWord: true,
      uppercase: true,
    },
    zoomIntensity: 1.3,
    showHookText: true,
    showProgressBar: true,
    silenceRemovalThresholdSeconds: 0.6,
  },
};
