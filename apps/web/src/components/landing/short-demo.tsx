"use client";

import { useEffect, useState } from "react";
import { ScoreRing } from "../ui";

// Una frase da live come la sottotitola il worker: una parola alla volta, il rosso sulle urla, il
// giallo sulla parola che conta.
const WORDS: Array<{ text: string; tone?: "scream" | "key" }> = [
  { text: "RAGA" },
  { text: "GUARDATE" },
  { text: "QUA" },
  { text: "NOOO", tone: "scream" },
  { text: "L'HA" },
  { text: "PRESO" },
  { text: "DI" },
  { text: "TESTA", tone: "key" },
];
const WORD_MS = 440;
const PAUSE_MS = 1400;

/** Anteprima di uno Short come lo produce ClipForge: webcam sopra, gioco sotto, sottotitoli a pop sul confine. */
export function ShortDemo() {
  const [index, setIndex] = useState(3);

  useEffect(() => {
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    let i = 0;
    let timer: ReturnType<typeof setTimeout>;
    const tick = () => {
      setIndex(i);
      const last = i === WORDS.length - 1;
      i = last ? 0 : i + 1;
      timer = setTimeout(tick, last ? PAUSE_MS : WORD_MS);
    };
    tick();
    return () => clearTimeout(timer);
  }, []);

  const word = WORDS[index]!;
  const color = word.tone === "scream" ? "#ff2d3d" : word.tone === "key" ? "#ffd400" : "#fff";

  return (
    <div className="relative mx-auto w-[260px] sm:w-[290px]" aria-label="Esempio di Short con i sottotitoli animati" role="img">
      <div className="relative aspect-[9/16] overflow-hidden rounded-[2.2rem] border-[6px] border-[#1f1b27] bg-black shadow-[0_40px_80px_-30px_rgba(0,0,0,0.9)]">
        {/* Webcam */}
        <div className="absolute inset-x-0 top-0 h-[42%] overflow-hidden bg-[linear-gradient(160deg,#3a2b47_0%,#221a2c_70%)]">
          <div className="absolute bottom-0 left-1/2 h-[46%] w-[62%] -translate-x-1/2 rounded-t-[45%] bg-[#141019]" />
          <div className="absolute bottom-[38%] left-1/2 h-[34%] w-[26%] -translate-x-1/2 rounded-full bg-[#141019]" />
          <div className="absolute right-[14%] top-[18%] h-[26%] w-[8%] rounded-full bg-[#2c2236]" />
        </div>
        {/* Gioco */}
        <div className="absolute inset-x-0 bottom-0 h-[58%] overflow-hidden bg-[linear-gradient(180deg,#1d4f7a_0%,#3b86b0_55%,#4f9a5a_56%,#2f6b37_100%)]">
          <div className="absolute left-[10%] top-[48%] h-[16%] w-[12%] rounded-sm bg-[#8a3b2e]" />
          <div className="absolute right-[18%] top-[40%] h-[24%] w-[16%] rounded-sm bg-[#6e2a22]" />
          <div className="absolute left-1/2 top-[34%] h-[5%] w-[5%] -translate-x-1/2 rounded-full border-2 border-white/80" />
          <div className="absolute bottom-3 left-3 h-2 w-[40%] rounded-full bg-black/40">
            <div className="h-full w-[62%] rounded-full bg-[#ff2d3d]" />
          </div>
          <div className="absolute right-3 top-3 h-10 w-10 rounded-md border border-white/30 bg-black/30" />
        </div>
        {/* Sottotitolo sul confine webcam/gioco, come la posizione "smart" del worker */}
        <div className="absolute inset-x-0 top-[42%] flex -translate-y-1/2 justify-center">
          <span key={index} className="caption-demo type-caption text-[2.1rem] sm:text-[2.4rem]" style={{ color }}>
            {word.text}
          </span>
        </div>
        <div className="absolute right-3 top-3">
          <ScoreRing score={94} size={38} />
        </div>
      </div>
    </div>
  );
}
