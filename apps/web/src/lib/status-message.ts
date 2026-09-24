/** Frase da mostrare mentre un progetto è in elaborazione, fase per fase. */
export function statusMessage(status: string, sourceType?: string): string {
  switch (status) {
    case "UPLOADING":
    case "UPLOADED":
      return "In attesa che il worker prenda in carico il video…";
    case "DOWNLOADING":
      return sourceType === "twitch_vod" ? "Download del VOD da Twitch…" : "Download del video da YouTube…";
    case "EXTRACTING_AUDIO":
      return "Estrazione dell'audio…";
    case "TRANSCRIBING":
      return "Trascrizione del parlato…";
    case "ANALYZING":
      return "L'AI sta cercando i momenti migliori…";
    case "CLIP_SELECTION":
      return "Selezione delle clip migliori…";
    default:
      return "Elaborazione in corso…";
  }
}
