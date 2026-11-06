import "dotenv/config";
import { channelBrandingForProject, renderSubscribeBanner } from "../render/subscribe-banner.js";
import { runFfmpeg } from "../lib/ffmpeg.js";

/**
 * Anteprima del banner "iscriviti" (gratis): lo crea per il canale del progetto e lo sovrappone a un
 * fotogramma vero, poi un foglio coi momenti chiave. Uso: tsx src/dev/banner-preview.ts <project_id> <sorgente> <secondo> <out.jpg>
 */
const [projectId, source, at, out] = process.argv.slice(2);
const branding = await channelBrandingForProject(projectId!);
console.log("canale:", branding);
const banner = await renderSubscribeBanner(branding!);
if (!banner) throw new Error("banner non creato");
const times = [0.15, 0.4, 1.2, 1.55, 1.75, 2.62, 2.9, 4.2, 5.1];
await runFfmpeg([
  "-y", "-ss", at!, "-t", "6", "-i", source!, "-i", banner.path,
  "-filter_complex",
  `[0:v]scale=1920:1080,setsar=1[bg];[bg][1:v]overlay=x=(W-w)/2:y=H-h-70:eof_action=pass,select='${times.map((t) => `between(t,${t},${t + 0.034})`).join("+")}',scale=960:-2,tile=3x3`,
  "-frames:v", "1", "-vsync", "0", out!,
]);
console.log("foglio:", out, "banner:", banner.path);
