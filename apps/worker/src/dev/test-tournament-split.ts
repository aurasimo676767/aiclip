import { buildVideosFromTimeline, fmt } from "../providers/ai/longform-plan.js";

// Prova gratuita della divisione dei tornei per gioco e dei giochi lunghi mai divisi.
const m = (a: number) => a * 60;
const T = "Torneo Impossibile";
const timeline = [
  { start: m(0), end: m(10), kind: "setup", activity: T, what: "regole del torneo" },
  { start: m(10), end: m(12), kind: "wheel", activity: T, what: "la ruota sceglie Fortnite" },
  { start: m(12), end: m(40), kind: "tournament_game", activity: T, what: "Fortnite: primo round" },
  { start: m(40), end: m(70), kind: "tournament_game", activity: T, what: "Fortnite: secondo round" },
  { start: m(70), end: m(72), kind: "wheel", activity: T, what: "la ruota sceglie REMATCH" },
  { start: m(72), end: m(110), kind: "tournament_game", activity: T, what: "REMATCH: tre partite" },
  { start: m(110), end: m(111), kind: "wheel", activity: T, what: "la ruota sceglie Brainrot Kart" },
  { start: m(111), end: m(115), kind: "tournament_game", activity: T, what: "Brainrot Kart: una gara" },
  { start: m(115), end: m(125), kind: "outro", activity: T, what: "classifica finale" },
  { start: m(130), end: m(330), kind: "game", activity: "Affari Tuoi", what: "Affari Tuoi: pacchi" },
] as never;
for (const v of buildVideosFromTimeline(timeline)) console.log(`${fmt(v.start)}-${fmt(v.end)}  ${v.kind}  ${v.activity}  | apre: ${v.opening} | torneo: ${v.tournament ?? "-"}`);
