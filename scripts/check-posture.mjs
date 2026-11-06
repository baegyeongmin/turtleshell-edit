// node scripts/check-posture.mjs — runs src/posture.js on MediaPipe lite landmarks recorded from webcam
// test frames of five people (6 crop/scale jitters each; "x" = person not detected in that jitter)
// and asserts the score separates good from bad posture for every one of them.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { extractFeatures, slouchDeviation, deviationToScore, medianFeatures } from "../src/posture.js";

const fixture = JSON.parse(readFileSync(new URL("./posture-fixture.json", import.meta.url)));
const START = 2, PEAK = 6; // BLUR_START_SCORE / BLUR_PEAK_SCORE in offscreen.js
const people = [...new Set(Object.keys(fixture).map(key => key.split("-")[0]))];

for (const person of people) {
  const features = pose => (fixture[`${person}-${pose}`] || []).map(f => f ? extractFeatures(f.lm, f.world) : { valid: false });
  const baseline = medianFeatures(features("up").filter(f => f.valid));
  const scores = pose => features(pose).filter(f => f.valid).map(f => deviationToScore(slouchDeviation(f.pose, baseline.pose)));
  for (const pose of ["up", "turtle", "slouch", "back", "turn"]) {
    if (!fixture[`${person}-${pose}`]) continue;
    const s = scores(pose);
    console.log(`${person}-${pose}`.padEnd(10), s.map(v => v.toFixed(1)).join(" "));
    const bad = pose === "turtle" || pose === "slouch";
    if (bad) assert(Math.min(...s) >= PEAK, `${person}-${pose} must reach full blur`);
    else assert(Math.max(...s) < START, `${person}-${pose} must not blur`);
  }
}
console.log("posture checks passed");
