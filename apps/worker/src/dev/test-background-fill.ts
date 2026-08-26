import { buildVideoFilterComplex } from "../render/build-video-filter.js";
import { runFfmpeg } from "../lib/ffmpeg.js";

// Layout sintetico: "single" con backgroundFill, volto grande (600x800) ma spostato in basso
// nel frame sorgente 1920x1080 — il caso reale segnalato (webcam grande e decentrata verso il
// basso, prima finiva stirata in alto mostrando sopra il volto contenuto irrilevante).
const filterComplex = buildVideoFilterComplex({
  layout: {
    type: "single",
    backgroundFill: true,
    crops: [{ startSeconds: 0, endSeconds: 5, crop: { x: 660, y: 400, width: 600, height: 680 } }],
  },
  zoomExpression: "1.0",
  assSubtitlesPath: "",
  showProgressBar: false,
  clipDurationSeconds: 5,
});

console.log("--- filter_complex generato ---");
console.log(filterComplex);

const withoutSubs = filterComplex
  .replace(/;\n\[subbed\]null\[vout\]/, "")
  .replace(/subtitles='.*?'\[subbed\]/, "null[vout]");

runFfmpeg([
  "-y",
  "-f",
  "lavfi",
  "-i",
  "testsrc=size=1920x1080:duration=5:rate=25",
  "-t",
  "3",
  "-filter_complex",
  withoutSubs,
  "-map",
  "[vout]",
  "-an",
  "test-background-fill-out.mp4",
])
  .then(() => console.log("OK: ffmpeg ha renderizzato senza errori -> test-background-fill-out.mp4"))
  .catch((e) => {
    console.error("ERRORE ffmpeg:", e.message);
    process.exit(1);
  });
