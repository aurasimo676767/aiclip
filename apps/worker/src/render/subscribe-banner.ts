import fsp from "node:fs/promises";
import path from "node:path";
import { google } from "googleapis";
import { Resvg } from "@resvg/resvg-js";
import { env } from "../env.js";
import { runFfmpeg } from "../lib/ffmpeg.js";
import { logger } from "../lib/logger.js";
import { supabase } from "../lib/supabase.js";

/**
 * Banner "iscriviti" dei video lunghi montati (simo, 2026-11-05: "ogni tot spunti un'animazione con
 * un piccolo banner, con il nome del canale, la foto profilo, e il mouse che va sull'iscriviti... ma
 * non deve essere full finto tipo IA, ma serio e fatto bene come gli altri canali").
 *
 * È il "lower third" che usano i canali grandi: una pillola scura e sobria con foto profilo e nome
 * VERI del canale YouTube collegato, il pulsante rosso ISCRIVITI e la campanella. Entra da sinistra,
 * il cursore arriva sul pulsante, clic (il pulsante diventa "ISCRITTO"), poi sulla campanella che
 * oscilla, ed esce. Si disegna fotogramma per fotogramma (SVG -> PNG) e diventa un video con la
 * trasparenza, sovrapposto al montato in BANNER_EVERY_SECONDS.
 */

const FPS = 30;
const DURATION = 5.6;
const W = 1000;
const H = 250;
/** Distanza dal bordo in basso del video 1920x1080. */
export const BANNER_BOTTOM_MARGIN = 70;
/**
 * Due banner (simo, 2026-11-06): uno all'inizio, "non proprio il primo secondo, ma tipo al 10" (dopo
 * l'intro "IN QUESTO VIDEO", se c'è), e uno verso metà video "in momenti dove salta all'occhio": un
 * tratto tranquillo, lontano dagli zoom e dagli stacchi del montaggio, fra il 35% e il 65% del video.
 */
const FIRST_AT_SECONDS = 10;
const AFTER_INTRO_SECONDS = 4;
const MIDDLE_FROM = 0.35;
const MIDDLE_TO = 0.65;
/** Un video più corto di così ha solo il primo banner. */
const MIN_SECONDS_FOR_SECOND = 150;
/** Il suono del banner (whoosh, clic, campanella), sotto le voci. */
const SFX_VOLUME = 0.55;

const FONT_REGULAR = "C:\\Windows\\Fonts\\segoeui.ttf";
const FONT_BOLD = "C:\\Windows\\Fonts\\segoeuib.ttf";

export interface ChannelBranding {
  channelId: string;
  title: string;
  avatarPath: string | null;
}

/** Nome e foto profilo del canale YouTube collegato dal proprietario del progetto (foto in cache per 7 giorni). */
export async function channelBrandingForProject(projectId: string): Promise<ChannelBranding | null> {
  const { data: project } = await supabase.from("projects").select("user_id").eq("id", projectId).maybeSingle();
  if (!project) return null;
  const { data: conn } = await supabase.from("youtube_connections").select("*").eq("user_id", project.user_id).maybeSingle();
  if (!conn) return null;
  const dir = path.join(env.WORKER_TMP_DIR, "branding");
  await fsp.mkdir(dir, { recursive: true });
  const avatarPath = path.join(dir, `${conn.channel_id}.jpg`);
  const infoPath = path.join(dir, `${conn.channel_id}.json`);
  const fresh = await fsp.stat(infoPath).then((s) => Date.now() - s.mtimeMs < 7 * 86400_000).catch(() => false);
  if (fresh) {
    const info = JSON.parse(await fsp.readFile(infoPath, "utf8")) as ChannelBranding;
    return { ...info, avatarPath: (await fsp.access(avatarPath).then(() => true).catch(() => false)) ? avatarPath : null };
  }
  try {
    const auth = new google.auth.OAuth2(env.GOOGLE_CLIENT_ID, env.GOOGLE_CLIENT_SECRET);
    auth.setCredentials({ access_token: conn.access_token, refresh_token: conn.refresh_token, expiry_date: new Date(conn.expires_at).getTime() });
    const res = await google.youtube({ version: "v3", auth }).channels.list({ part: ["snippet"], id: [conn.channel_id] });
    const snippet = res.data.items?.[0]?.snippet;
    const title = snippet?.title ?? conn.channel_title;
    const url = snippet?.thumbnails?.high?.url ?? snippet?.thumbnails?.medium?.url ?? snippet?.thumbnails?.default?.url;
    let gotAvatar = false;
    if (url) {
      const img = await fetch(url);
      if (img.ok) {
        await fsp.writeFile(avatarPath, Buffer.from(await img.arrayBuffer()));
        gotAvatar = true;
      }
    }
    const info: ChannelBranding = { channelId: conn.channel_id, title, avatarPath: null };
    await fsp.writeFile(infoPath, JSON.stringify(info));
    return { ...info, avatarPath: gotAvatar ? avatarPath : null };
  } catch (error) {
    logger.warn("Canale YouTube per il banner non letto: uso il nome salvato", { error: error instanceof Error ? error.message : String(error) });
    return { channelId: conn.channel_id, title: conn.channel_title, avatarPath: null };
  }
}

/**
 * Quando far comparire il banner nel montato (secondi del video finale). `busy` sono gli istanti da
 * cui stare lontani (zoom, stacchi): il banner di metà video va dove ce ne sono meno attorno.
 */
export function bannerTimes(outputDuration: number, introSeconds: number, busy: number[] = []): number[] {
  const first = Math.max(FIRST_AT_SECONDS, introSeconds + AFTER_INTRO_SECONDS);
  if (first + DURATION > outputDuration) return [];
  const out = [first];
  if (outputDuration < MIN_SECONDS_FOR_SECOND) return out;
  // Il punto più tranquillo: il più lontano da zoom e stacchi durante i suoi secondi (e poco prima).
  let best: { t: number; score: number } | null = null;
  for (let t = outputDuration * MIDDLE_FROM; t <= outputDuration * MIDDLE_TO - DURATION; t += 1) {
    const calm = Math.min(60, ...busy.map((b) => (b < t - 2 ? t - 2 - b : b > t + DURATION ? b - t - DURATION : 0)));
    // A parità di calma, più vicino alla metà.
    const score = calm - Math.abs(t + DURATION / 2 - outputDuration / 2) / 60;
    if (!best || score > best.score) best = { t, score };
  }
  if (best) out.push(best.t);
  return out;
}

/**
 * Il suono del banner, lungo quanto il banner: whoosh quando entra, clic del mouse su ISCRIVITI e
 * sulla campanella, un "ding" corto quando si accende. Sintetizzato una volta e tenuto su disco.
 */
export async function ensureBannerSfx(): Promise<string | null> {
  const out = path.join(env.WORKER_TMP_DIR, "branding", "banner-sfx-v1.wav");
  if (await fsp.access(out).then(() => true).catch(() => false)) return out;
  const whoosh = path.resolve(process.cwd(), "assets", "sfx", "headline-whoosh.wav");
  const hasWhoosh = await fsp.access(whoosh).then(() => true).catch(() => false);
  // Clic: un colpo corto e secco (rumore filtrato + un tic acuto), come il tasto di un mouse.
  const click = "aevalsrc=exprs='(random(0)-0.5)*1.6*exp(-t*900)+0.5*sin(2*PI*3200*t)*exp(-t*600)':s=44100:d=0.06";
  // Campanella: due armoniche che si spengono in fretta.
  const ding = "aevalsrc=exprs='0.32*sin(2*PI*1568*t)*exp(-t*5)+0.14*sin(2*PI*3136*t)*exp(-t*8)':s=44100:d=1.2";
  const parts: string[] = [];
  const inputs: string[] = [];
  let n = 0;
  if (hasWhoosh) {
    inputs.push("-i", whoosh);
    parts.push(`[${n}:a]aformat=sample_rates=44100:channel_layouts=stereo,volume=0.45,atrim=0:1.2[s${n}]`);
    n++;
  }
  const hits: Array<[string, number, number]> = [
    [click, 1500, 0.9],
    [click, 2600, 0.9],
    [ding, 2660, 0.8],
  ];
  for (const [src, delayMs, vol] of hits) {
    inputs.push("-f", "lavfi", "-i", src);
    parts.push(`[${n}:a]aformat=sample_rates=44100:channel_layouts=stereo,volume=${vol},adelay=${delayMs}|${delayMs}[s${n}]`);
    n++;
  }
  const labels = Array.from({ length: n }, (_, i) => `[s${i}]`).join("");
  parts.push(`${labels}amix=inputs=${n}:duration=longest:normalize=0,apad=whole_dur=${DURATION},atrim=0:${DURATION},volume=${SFX_VOLUME}[a]`);
  try {
    await fsp.mkdir(path.dirname(out), { recursive: true });
    await runFfmpeg(["-y", ...inputs, "-filter_complex", parts.join(";"), "-map", "[a]", "-ar", "44100", "-ac", "2", out]);
    return out;
  } catch (error) {
    logger.warn("Suono del banner non creato: banner senza suono", { error: error instanceof Error ? error.message : String(error) });
    return null;
  }
}

const clamp01 = (x: number) => Math.min(1, Math.max(0, x));
const easeOutCubic = (x: number) => 1 - (1 - clamp01(x)) ** 3;
const easeInOutCubic = (x: number) => {
  const t = clamp01(x);
  return t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2;
};
/** Rimbalzo morbido in uscita (supera di poco e torna), per l'entrata della pillola. */
const easeOutBack = (x: number) => {
  const t = clamp01(x);
  const c1 = 1.2;
  return 1 + (c1 + 1) * (t - 1) ** 3 + c1 * (t - 1) ** 2;
};
const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

// Geometria (pixel del banner).
const CARD = { x: 20, y: 40, w: 930, h: 132, r: 66 };
const AVATAR = { cx: CARD.x + 70, cy: CARD.y + CARD.h / 2, r: 48 };
const BUTTON = { x: CARD.x + 606, y: CARD.y + 34, w: 220, h: 64 };
const BELL = { cx: CARD.x + 870, cy: CARD.y + CARD.h / 2, r: 30 };

function cursorAt(t: number): { x: number; y: number; opacity: number; press: number } {
  const start = { x: W - 20, y: H - 10 };
  const onButton = { x: BUTTON.x + BUTTON.w * 0.55, y: BUTTON.y + BUTTON.h * 0.55 };
  const onBell = { x: BELL.cx + 4, y: BELL.cy + 6 };
  const exit = { x: W + 40, y: H + 40 };
  const press = (at: number) => (t >= at && t < at + 0.16 ? Math.sin(((t - at) / 0.16) * Math.PI) : 0);
  if (t < 0.6) return { ...start, opacity: 0, press: 0 };
  if (t < 1.45) {
    const k = easeInOutCubic((t - 0.6) / 0.85);
    return { x: lerp(start.x, onButton.x, k), y: lerp(start.y, onButton.y, k) - Math.sin(k * Math.PI) * 30, opacity: clamp01((t - 0.6) / 0.15), press: 0 };
  }
  if (t < 1.95) return { ...onButton, opacity: 1, press: press(1.5) };
  if (t < 2.55) {
    const k = easeInOutCubic((t - 1.95) / 0.6);
    return { x: lerp(onButton.x, onBell.x, k), y: lerp(onButton.y, onBell.y, k) - Math.sin(k * Math.PI) * 16, opacity: 1, press: 0 };
  }
  if (t < 3.2) return { ...onBell, opacity: 1, press: press(2.6) };
  const k = easeInOutCubic((t - 3.2) / 0.7);
  return { x: lerp(onBell.x, exit.x, k), y: lerp(onBell.y, exit.y, k), opacity: 1 - clamp01((t - 3.5) / 0.4), press: 0 };
}

function frameSvg(t: number, title: string, avatar: string | null): string {
  // Entrata (0-0,5 s) e uscita (4,9-5,4 s) della pillola.
  const enter = easeOutBack(t / 0.5);
  const leave = easeInOutCubic((t - 4.9) / 0.5);
  const dx = lerp(-70, 0, enter) - 60 * leave;
  const opacity = clamp01(t / 0.25) * (1 - leave);
  const subscribed = t >= 1.58;
  const buttonPress = t >= 1.5 && t < 1.66 ? 1 - 0.06 * Math.sin(((t - 1.5) / 0.16) * Math.PI) : 1;
  const ring = t >= 1.55 && t < 2.1 ? (t - 1.55) / 0.55 : -1;
  const bellOn = t >= 2.66;
  const swing = t >= 2.66 && t < 3.6 ? 18 * Math.exp(-(t - 2.66) * 3.2) * Math.sin((t - 2.66) * 22) : 0;
  const cursor = cursorAt(t);
  const name = title.length > 26 ? `${title.slice(0, 25)}…` : title;
  const nameSize = name.length > 18 ? 34 : 38;

  const bx = BUTTON.x + BUTTON.w / 2;
  const by = BUTTON.y + BUTTON.h / 2;
  const button = subscribed
    ? `<rect x="${BUTTON.x}" y="${BUTTON.y}" width="${BUTTON.w}" height="${BUTTON.h}" rx="${BUTTON.h / 2}" fill="#3a3a3d"/>
       <path d="M ${bx - 80} ${by + 1} l 8 8 l 15 -17" fill="none" stroke="#e8e8e8" stroke-width="5" stroke-linecap="round" stroke-linejoin="round"/>
       <text x="${bx + 16}" y="${by + 10}" text-anchor="middle" font-family="Segoe UI" font-weight="bold" font-size="26" fill="#e8e8e8" letter-spacing="1">ISCRITTO</text>`
    : `<rect x="${BUTTON.x}" y="${BUTTON.y}" width="${BUTTON.w}" height="${BUTTON.h}" rx="${BUTTON.h / 2}" fill="#ff0033"/>
       <text x="${bx}" y="${by + 10}" text-anchor="middle" font-family="Segoe UI" font-weight="bold" font-size="28" fill="#ffffff" letter-spacing="1">ISCRIVITI</text>`;
  const bellPath = `M 0 -17 C -9 -17 -13 -10 -13 -3 L -13 7 L -17 12 L 17 12 L 13 7 L 13 -3 C 13 -10 9 -17 0 -17 Z M -5 15 A 5 5 0 0 0 5 15 Z`;

  return `<svg width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink">
  <defs>
    <filter id="shadow" x="-10%" y="-30%" width="120%" height="170%"><feDropShadow dx="0" dy="8" stdDeviation="12" flood-color="#000" flood-opacity="0.45"/></filter>
    <clipPath id="avatar"><circle cx="${AVATAR.cx}" cy="${AVATAR.cy}" r="${AVATAR.r}"/></clipPath>
    <linearGradient id="glass" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#1c1c1f"/><stop offset="1" stop-color="#0e0e10"/></linearGradient>
  </defs>
  <g opacity="${opacity.toFixed(3)}" transform="translate(${dx.toFixed(2)} 0)">
    <rect x="${CARD.x}" y="${CARD.y}" width="${CARD.w}" height="${CARD.h}" rx="${CARD.r}" fill="url(#glass)" fill-opacity="0.94" filter="url(#shadow)"/>
    <rect x="${CARD.x + 0.75}" y="${CARD.y + 0.75}" width="${CARD.w - 1.5}" height="${CARD.h - 1.5}" rx="${CARD.r}" fill="none" stroke="#ffffff" stroke-opacity="0.12" stroke-width="1.5"/>
    ${avatar ? `<image x="${AVATAR.cx - AVATAR.r}" y="${AVATAR.cy - AVATAR.r}" width="${AVATAR.r * 2}" height="${AVATAR.r * 2}" preserveAspectRatio="xMidYMid slice" clip-path="url(#avatar)" xlink:href="data:image/jpeg;base64,${avatar}"/>` : `<circle cx="${AVATAR.cx}" cy="${AVATAR.cy}" r="${AVATAR.r}" fill="#ff0033"/>`}
    <circle cx="${AVATAR.cx}" cy="${AVATAR.cy}" r="${AVATAR.r + 2}" fill="none" stroke="#ffffff" stroke-opacity="0.9" stroke-width="3"/>
    <text x="${AVATAR.cx + AVATAR.r + 26}" y="${CARD.y + 62}" font-family="Segoe UI" font-weight="bold" font-size="${nameSize}" fill="#ffffff">${esc(name)}</text>
    <text x="${AVATAR.cx + AVATAR.r + 27}" y="${CARD.y + 98}" font-family="Segoe UI" font-size="22" fill="#b9b9be">Iscriviti per non perderti i prossimi video</text>
    <g transform="translate(${bx} ${by}) scale(${buttonPress.toFixed(4)}) translate(${-bx} ${-by})">${button}</g>
    ${ring >= 0 ? `<rect x="${BUTTON.x - ring * 14}" y="${BUTTON.y - ring * 14}" width="${BUTTON.w + ring * 28}" height="${BUTTON.h + ring * 28}" rx="${BUTTON.h / 2 + ring * 14}" fill="none" stroke="#ffffff" stroke-opacity="${(0.5 * (1 - ring)).toFixed(3)}" stroke-width="3"/>` : ""}
    <circle cx="${BELL.cx}" cy="${BELL.cy}" r="${BELL.r}" fill="${bellOn ? "#ffffff" : "#2a2a2d"}"/>
    <g transform="translate(${BELL.cx} ${BELL.cy}) rotate(${swing.toFixed(2)} 0 -15)"><path d="${bellPath}" fill="${bellOn ? "#0e0e10" : "#e8e8e8"}"/></g>
  </g>
  <g opacity="${cursor.opacity.toFixed(3)}" transform="translate(${cursor.x.toFixed(2)} ${cursor.y.toFixed(2)}) scale(${(1 - 0.12 * cursor.press).toFixed(4)})">
    <path d="M 0 0 L 0 34 L 8 26 L 14 40 L 20 37 L 14 24 L 25 24 Z" fill="#ffffff" stroke="#111111" stroke-width="2.2" stroke-linejoin="round" filter="url(#shadow)"/>
  </g>
</svg>`;
}

/**
 * Il video del banner (con trasparenza) per questo canale; si rifà solo se cambiano nome o foto.
 * null se non si riesce: il montato esce lo stesso, senza banner.
 */
export async function renderSubscribeBanner(branding: ChannelBranding): Promise<{ path: string; width: number; height: number; duration: number } | null> {
  const dir = path.join(env.WORKER_TMP_DIR, "branding");
  const out = path.join(dir, `banner-${branding.channelId}-v2.mov`);
  const ready = await fsp.access(out).then(() => true).catch(() => false);
  const infoStamp = path.join(dir, `banner-${branding.channelId}-v2.title`);
  const stamp = `${branding.title}|${branding.avatarPath ? (await fsp.stat(branding.avatarPath)).mtimeMs : 0}`;
  if (ready && (await fsp.readFile(infoStamp, "utf8").catch(() => "")) === stamp) return { path: out, width: W, height: H, duration: DURATION };
  const framesDir = path.join(dir, `frames-${branding.channelId}`);
  try {
    await fsp.rm(framesDir, { recursive: true, force: true });
    await fsp.mkdir(framesDir, { recursive: true });
    const avatar = branding.avatarPath ? (await fsp.readFile(branding.avatarPath)).toString("base64") : null;
    const frames = Math.round(DURATION * FPS);
    for (let i = 0; i < frames; i++) {
      const svg = frameSvg(i / FPS, branding.title, avatar);
      const png = new Resvg(svg, { font: { fontFiles: [FONT_REGULAR, FONT_BOLD], loadSystemFonts: false, defaultFontFamily: "Segoe UI" } }).render().asPng();
      await fsp.writeFile(path.join(framesDir, `f${String(i).padStart(4, "0")}.png`), png);
    }
    await runFfmpeg(["-y", "-framerate", String(FPS), "-i", path.join(framesDir, "f%04d.png"), "-c:v", "qtrle", "-pix_fmt", "argb", out]);
    await fsp.writeFile(infoStamp, stamp);
    return { path: out, width: W, height: H, duration: DURATION };
  } catch (error) {
    logger.warn("Banner iscriviti non creato: montato senza banner", { error: error instanceof Error ? error.message : String(error) });
    return null;
  } finally {
    await fsp.rm(framesDir, { recursive: true, force: true }).catch(() => undefined);
  }
}
