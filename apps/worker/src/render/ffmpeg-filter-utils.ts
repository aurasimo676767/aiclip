/**
 * Converte un path del filesystem in una forma sicura da usare come valore di
 * un'opzione dentro un filtro ffmpeg (es. subtitles=<path>). ffmpeg tratta `:` come
 * separatore di opzioni e `\` come escape all'interno della stringa del filtergraph,
 * quindi su Windows (path tipo `C:\Users\...`) serve normalizzare gli slash ed
 * escapare i due punti.
 */
export function toFfmpegFilterPath(filePath: string): string {
  return filePath.replace(/\\/g, "/").replace(/:/g, "\\:");
}
