import { censorText, censorWord } from "@clipforge/shared";
const tests = [
  "LA STRATEGIA CONTRO I CICCIONI E' L'INSALATA?! 🥗💀",
  "E' PIENO DI CICCIONI IN QUESTA STANZA?! 💀🤣",
  "porco dio che schifo, dio cane",
  "Download del video, un negroni, down",
  "Sei un coglione, stronzo, vaffanculo",
  "LITE FURIOSA FINISCE COSI'..?! 🤬💀",
  "IN UNA SERA E' STATO HITLER E GOKU..?!",
];
for (const t of tests) console.log(censorText(t));
console.log(["CICCIONI", "cazzo", "dio", "ciao"].map(censorWord).join(" | "));
