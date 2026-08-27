import { buildPerformanceFeedback } from "../providers/ai/performance-feedback.js";

const userId = process.argv[2];
if (!userId) {
  console.error("Uso: tsx src/dev/test-performance-feedback.ts <userId>");
  process.exit(1);
}

const feedback = await buildPerformanceFeedback(userId);
console.log(feedback ?? "(null — non abbastanza storico)");
