import "server-only";
import { readTextObject, writeTextObject } from "./storage/r2";

/**
 * Allenamento delle copertine (stesso formato di apps/worker/src/lib/cover-inspo.ts): i canali da
 * seguire e la richiesta "Allena adesso" in cover-inspo/<userId>/config.json, le copertine studiate in
 * index.json. Il sito scrive solo canali e richiesta; il resto lo scrive il worker.
 */
export interface InspoChannel {
  url: string;
  name?: string;
  /** Stile preferito di simo: pesa anche se il canale fa poche visualizzazioni. */
  favorite?: boolean;
}

export interface InspoConfig {
  channels: InspoChannel[];
  trainRequestedAt?: string | null;
  lastTrainedAt?: string | null;
  training?: { startedAt: string; done: number; total: number; step: string } | null;
  lastError?: string | null;
  lastSummary?: string | null;
}

export interface InspoItem {
  videoId: string;
  channel: string;
  title: string;
  views: number | null;
  outlier: number | null;
  source: "canale" | "approvata";
  path: string;
  analysis?: { kind: string; game: string | null; text: string | null; hook: string; scene: string };
}

/** Gli stessi del worker (DEFAULT_INSPO_CHANNELS): proposti finché simo non salva i suoi. */
export const DEFAULT_INSPO_CHANNELS: InspoChannel[] = [
  { url: "https://www.youtube.com/@AvraiAuraBooter", name: "Avrai Aura Booter" },
  { url: "https://www.youtube.com/@BlurIndietro", name: "Blur Indietro" },
  { url: "https://www.youtube.com/@SdrogoLoco", name: "SdrogoLoco" },
  { url: "https://www.youtube.com/@CircolinoClip", name: "CircolinoClip", favorite: true },
];

const configKey = (userId: string) => `cover-inspo/${userId}/config.json`;
const indexKey = (userId: string) => `cover-inspo/${userId}/index.json`;

export async function readInspoConfig(userId: string): Promise<InspoConfig | null> {
  const text = await readTextObject(configKey(userId));
  return text ? (JSON.parse(text) as InspoConfig) : null;
}

export async function writeInspoConfig(userId: string, config: InspoConfig): Promise<void> {
  await writeTextObject(configKey(userId), JSON.stringify(config));
}

export async function readInspoIndex(userId: string): Promise<{ items: InspoItem[] }> {
  const text = await readTextObject(indexKey(userId));
  return text ? (JSON.parse(text) as { items: InspoItem[] }) : { items: [] };
}
