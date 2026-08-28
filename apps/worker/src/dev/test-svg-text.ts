import fsp from "node:fs/promises";
import path from "node:path";
import { Resvg } from "@resvg/resvg-js";

const fontPath = path.join(process.cwd(), "assets/fonts/Anton-Regular.ttf");

const svg = `<svg width="1280" height="300" xmlns="http://www.w3.org/2000/svg">
  <text x="50" y="180" font-family="Anton" font-size="110" fill="white" stroke="black" stroke-width="10" paint-order="stroke fill">BLUR REACTION</text>
</svg>`;

const resvg = new Resvg(svg, {
  font: {
    fontFiles: [fontPath],
    loadSystemFonts: false,
    defaultFontFamily: "Anton",
  },
});
const rendered = resvg.render();
const png = rendered.asPng();

await fsp.mkdir("tmp", { recursive: true });
await fsp.writeFile("tmp/svg-text-test.png", png);
console.log("scritto tmp/svg-text-test.png");
