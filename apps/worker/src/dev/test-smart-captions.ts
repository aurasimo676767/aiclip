import { DEFAULT_TEMPLATES } from "@clipforge/shared";
import type { TranscriptSegment } from "@clipforge/shared";
import type { Layout } from "../face-tracking/face-tracker.js";
import { buildAssSubtitles } from "../render/captions.js";

const segments: TranscriptSegment[] = [
  {
    id: 0,
    start: 0,
    end: 4,
    text: "ciao a tutti oggi parliamo di questo",
    words: [
      { word: "ciao", start: 0, end: 0.4 },
      { word: "a", start: 0.4, end: 0.5 },
      { word: "tutti", start: 0.5, end: 1 },
      { word: "oggi", start: 3, end: 3.4 },
      { word: "parliamo", start: 3.4, end: 3.9 },
      { word: "di", start: 3.9, end: 4 },
      { word: "questo", start: 4, end: 4.4 },
    ],
  },
];

const layout: Layout = {
  type: "mixed",
  singleCrops: [{ startSeconds: 0, endSeconds: 5, crop: { x: 0, y: 0, width: 100, height: 100 } }],
  backgroundFill: false,
  splitCrops: [{ startSeconds: 0, endSeconds: 2, crop: { x: 0, y: 0, width: 100, height: 100 } }],
  bottom: { x: 0, y: 0, width: 100, height: 100 },
  topRatio: 0.35,
  blurRegions: [],
};

const ass = buildAssSubtitles(segments, DEFAULT_TEMPLATES.STREAMER.captionStyle, { layout });
console.log(ass);
