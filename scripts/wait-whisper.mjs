// Aspetta che il server Whisper locale risponda prima di lanciare il worker (usato da dev:worker:local).
// 2026-10-25: il worker, partito insieme a Whisper, ha preso un VOD mentre il modello stava ancora
// caricando sulla GPU, è fallito al terzo tentativo e ha cancellato i 14 GB già scaricati.
const url = process.env.LOCAL_WHISPER_URL ?? "http://127.0.0.1:8765";
const deadline = Date.now() + 10 * 60 * 1000;

while (Date.now() < deadline) {
  try {
    // Qualsiasi risposta HTTP (anche 404 sulla radice) vuol dire che il server è su e il modello caricato.
    await fetch(url, { signal: AbortSignal.timeout(3000) });
    console.log(`[wait-whisper] Whisper pronto su ${url}, avvio il worker`);
    process.exit(0);
  } catch {
    await new Promise((r) => setTimeout(r, 2000));
  }
}
console.error(`[wait-whisper] Whisper non risponde su ${url} dopo 10 minuti: avvio il worker lo stesso`);
process.exit(0);
