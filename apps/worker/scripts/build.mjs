import { build } from "esbuild";
import { rm } from "node:fs/promises";

/**
 * Bundle di produzione del worker con esbuild.
 *
 * @clipforge/shared e @clipforge/db sono consumati come sorgente TS diretto dal monorepo
 * (nessun proprio "dist"): un `tsc` classico produrrebbe un dist/index.js che poi, a
 * runtime, prova a risolvere quei package tramite il loro "exports" -> "./src/index.ts",
 * che Node non sa eseguire senza un loader TS. esbuild invece li BUNDLA direttamente nel
 * file di output, così `node dist/index.js` funziona da solo. Le dipendenze npm reali
 * restano esterne (richieste da node_modules a runtime, come da deploy standard).
 */

const EXTERNAL_PACKAGES = [
  "@anthropic-ai/sdk",
  "openai",
  "dotenv",
  "zod",
  "@supabase/supabase-js",
  "@aws-sdk/client-s3",
  "@aws-sdk/s3-request-presigner",
  // Contiene un addon nativo (.node) specifico per piattaforma: non bundlabile da esbuild,
  // deve restare un require verso node_modules a runtime.
  "onnxruntime-node",
];

await rm("dist", { recursive: true, force: true });

await build({
  entryPoints: ["src/index.ts"],
  outfile: "dist/index.js",
  bundle: true,
  platform: "node",
  target: "node20",
  format: "esm",
  sourcemap: true,
  external: EXTERNAL_PACKAGES,
  banner: {
    // I pacchetti esterni in formato CJS (es. openai) importati da un bundle ESM
    // necessitano di `require` disponibile nello scope del modulo.
    js: "import { createRequire as __createRequire } from 'module'; const require = __createRequire(import.meta.url);",
  },
});

console.log("Build completata: dist/index.js");
