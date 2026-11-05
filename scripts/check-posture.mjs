// node scripts/check-posture.mjs — runs src/posture.js on MediaPipe lite landmarks recorded from five
// webcam test frames (6 crop/scale jitters each) and asserts the score separates good from bad posture.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { extractFeatures, slouchDeviation, deviationToScore, medianFeatures } from "../src/posture.js";

const fixture = JSON.parse(readFileSync(new URL("./posture-fixture.json", import.meta.url)));
const features = name => fixture[name].map(f => extractFeatures(f.lm, f.world));
const baseline = medianFeatures(features("up"));
const scores = name => features(name).map(f => deviationToScore(slouchDeviation(f.pose, baseline.pose)));
const START = 2, PEAK = 6; // BLUR_START_SCORE / BLUR_PEAK_SCORE in offscreen.js

for (const name of Object.keys(fixture)) console.log(name.padEnd(7), scores(name).map(s => s.toFixed(1)).join(" "));
assert(Math.max(...scores("up")) < START, "jitter alone must not blur");
assert(Math.max(...scores("back")) < START, "leaning back must not blur");
assert(Math.max(...scores("turn")) < START, "turning the head must not blur (also gated by orientation)");
assert(Math.min(...scores("turtle")) >= PEAK, "turtle neck must reach full blur");
assert(Math.min(...scores("slouch")) >= PEAK, "slouch must reach full blur");
console.log("posture checks passed");
