import "dotenv/config";
import { readFaceLibrary } from "../lib/face-library.js";

/** Da dove viene ogni foto di una persona (stesso ordine del foglio). Uso: tsx src/dev/person-faces-info.ts <user_id> <NOME> */
const [userId, name] = process.argv.slice(2);
const library = await readFaceLibrary(userId!, "tmp/faces-info");
const faces = library.faces.filter((f) => f.status === "labeled" && f.label === name && !f.tags?.includes("meme"));
faces.forEach((f, i) => console.log(i + 1, JSON.stringify({ ...f, embedding: undefined })));
