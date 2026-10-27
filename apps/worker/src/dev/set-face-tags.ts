import "dotenv/config";
import { readFaceLibrary, writeFaceLibrary } from "../lib/face-library.js";

/**
 * Cambia i tag delle foto di una persona usando i numeri del foglio di person-refs-sheet (stesso
 * ordine). Uso: tsx src/dev/set-face-tags.ts <user_id> <NOME> <+tag|-tag> <numeri|all> [<+tag|-tag> <numeri|all>]...
 * Es.: tsx src/dev/set-face-tags.ts <user> MARZA -ref all +noref 9,13,17
 */
const [userId, name, ...ops] = process.argv.slice(2);
const dir = "tmp/set-face-tags";
const library = await readFaceLibrary(userId!, dir);
const faces = library.faces.filter((f) => f.status === "labeled" && f.label === name && !f.tags?.includes("meme"));
for (let i = 0; i < ops.length; i += 2) {
  const op = ops[i]!;
  const which = ops[i + 1]!;
  const tag = op.slice(1);
  const targets = which === "all" ? faces : which.split(",").map((n) => faces[Number(n) - 1]!);
  for (const f of targets) {
    const tags = new Set(f.tags ?? []);
    if (op.startsWith("+")) tags.add(tag);
    else tags.delete(tag);
    f.tags = [...tags];
  }
}
await writeFaceLibrary(userId!, library, dir);
faces.forEach((f, i) => f.tags?.length && console.log(i + 1, f.id, f.tags.join(",")));
