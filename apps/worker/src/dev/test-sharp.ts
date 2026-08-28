import sharp from "sharp";

console.log("sharp versions:", sharp.versions);
const buf = await sharp({ create: { width: 10, height: 10, channels: 3, background: { r: 255, g: 0, b: 0 } } }).png().toBuffer();
console.log("PNG bytes:", buf.length);
