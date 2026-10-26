import { env } from "../env.js";

// Stampa il valore di un'impostazione NON segreta del worker (gratis). Uso: tsx src/dev/print-flag.ts SHORTS_HEADLINE
const name = process.argv[2] as keyof typeof env;
if (!name || /KEY|SECRET|TOKEN|PASSWORD/i.test(name)) throw new Error("Solo impostazioni non segrete");
console.log(name, "=", env[name]);
