import { transcriptionProvider } from "../lib/providers.js";

try {
  await transcriptionProvider.checkReady?.();
  console.log("checkReady: OK");
} catch (err) {
  console.log("checkReady ha lanciato (atteso se il server è spento):", err instanceof Error ? err.message : err);
}
