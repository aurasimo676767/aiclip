import type { CropWindow } from "./face-tracker.js";

// Forma di un overlay webcam: usata dal pannello degli Shorts (reaction-cam-face-tracker.ts) e dai
// primi piani dei video lunghi (closeup-cams.ts).

/**
 * Proporzioni ammesse per un overlay webcam. Una webcam riprende con un sensore orizzontale: i
 * formati reali stanno fra il 4:3 (1.33) e il 16:9 (1.78), e un ritaglio dell'inquadratura non si
 * allontana molto da lì. Il player del video reagito e i ritagli fatti al suo interno invece hanno
 * forme qualsiasi.
 *
 * Misurato su 8 webcam vere di 4 stream diversi: da 1.05 a 1.48. Sui riquadri falsi che arrivano
 * fino a questo controllo negli stessi video: 0.67, 0.86, 1.18, 2.32, 2.70. La finestra scarta
 * tutto ciò che è più alto che largo o largo il doppio dell'altezza, lasciando spazio al 16:9.
 */
const MIN_WEBCAM_ASPECT = 0.9;
const MAX_WEBCAM_ASPECT = 1.85;

/**
 * Un overlay webcam lascia vedere il gioco/il video reagito: è quello il suo scopo, quindi non può
 * prendersi lo schermo. Non è però necessariamente piccolo — su uno degli stream di prova la webcam
 * vera di Blur occupa il 21% dello schermo, quindi una soglia stretta la scarterebbe. Il falso con
 * proporzioni da webcam che va fermato qui (il player del video reagito, quasi a tutto schermo) sta
 * al 44.9%: la soglia sta larga in mezzo ai due.
 */
const MAX_WEBCAM_AREA_RATIO = 0.3;

/**
 * Un overlay webcam è ancorato a un bordo dello schermo (angolo o lato): è così che si compone una
 * scena da streaming, per non coprire il centro. Sulle stesse 8 webcam vere ognuna toccava almeno un
 * bordo (scarto massimo 2px), mentre un volto dentro un TikTok a metà schermo — che ha proporzioni e
 * dimensioni del tutto plausibili, quindi passa gli altri due controlli — distava 136px dal bordo
 * più vicino. La tolleranza è generosa (4% del lato) per non escludere layout che lasciano un
 * margine attorno alla cam.
 */
const WEBCAM_EDGE_TOLERANCE_RATIO = 0.04;

/**
 * Perché questo riquadro NON può essere una webcam, o null se è plausibile. I tre controlli sono
 * indipendenti e ognuno da solo lascerebbe passare qualche falso: vedi le costanti qui sopra per i
 * valori misurati che fissano ciascuna soglia.
 */
export function rejectionReasonForWebcamRect(rect: CropWindow, sourceWidth: number, sourceHeight: number): string | null {
  const aspect = rect.width / rect.height;
  if (!Number.isFinite(aspect) || aspect < MIN_WEBCAM_ASPECT || aspect > MAX_WEBCAM_ASPECT) {
    return `proporzioni non da webcam (${aspect.toFixed(2)})`;
  }
  const areaRatio = (rect.width * rect.height) / (sourceWidth * sourceHeight);
  if (areaRatio > MAX_WEBCAM_AREA_RATIO) {
    return `troppo grande per essere un inserto (${(areaRatio * 100).toFixed(1)}% dello schermo)`;
  }
  const tolX = sourceWidth * WEBCAM_EDGE_TOLERANCE_RATIO;
  const tolY = sourceHeight * WEBCAM_EDGE_TOLERANCE_RATIO;
  const touchesEdge =
    rect.x <= tolX || rect.y <= tolY || rect.x + rect.width >= sourceWidth - tolX || rect.y + rect.height >= sourceHeight - tolY;
  if (!touchesEdge) return "non tocca nessun bordo dello schermo, sta in mezzo al contenuto";
  return null;
}
