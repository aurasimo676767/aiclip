import fsp from "node:fs/promises";
import { composeCover, COVER_THEMES } from "../render/compose-cover.js";

/**
 * Prova il compositore di copertine da un file JSON: [{ out, background, kind, faces[], title, theme }].
 * Uso: tsx src/dev/test-compose-cover.ts <prove.json>
 */
const specs = JSON.parse(await fsp.readFile(process.argv[2]!, "utf8")) as Array<{ out: string; background: string; kind: "reaction" | "game"; faces: string[]; title: string; theme: string }>;
for (const s of specs) {
  await composeCover({ backgroundPath: s.background, kind: s.kind, faces: s.faces, title: s.title, theme: COVER_THEMES[s.theme] ?? COVER_THEMES.giallo!, outputPath: s.out });
  console.log("ok", s.out);
}
