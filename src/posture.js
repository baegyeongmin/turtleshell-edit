// Posture geometry, kept free of DOM/chrome APIs so scripts/check-posture.mjs can run it in node.
const VISIBLE = 0.35;
// Tuning knobs. Deviation 0 = baseline, ~0.4 = clear turtle neck on test frames.
export const DEVIATION_DEADZONE = 0.05; // landmark jitter on a still frame is ~0.016
export const DEVIATION_FULL = 0.30;     // deviation that maps to score 10
const HEAD_GROW_WEIGHT = 0.5;
const DEPTH_WEIGHT = 0.5;               // lite-model z is ~3x noisier than the 2D cues

export function extractFeatures(landmarks, worldLandmarks, aspect = 4 / 3) {
  const nose = landmarks[0];
  const leftEar = landmarks[7], rightEar = landmarks[8];
  const leftShoulder = landmarks[11], rightShoulder = landmarks[12];
  if (![nose, leftEar, rightEar, leftShoulder, rightShoulder].every(point => point && point.visibility > VISIBLE)) {
    return { valid: false, missing: true, reason: "얼굴 또는 어깨 랜드마크가 보이지 않음" };
  }
  const earMidX = (leftEar.x + rightEar.x) / 2;
  const earWidth = Math.max(0.02, Math.abs(leftEar.x - rightEar.x));
  const headTurn = (nose.x - earMidX) / earWidth;

  const world = worldLandmarks;
  const worldPoints = [world?.[7], world?.[8], world?.[11], world?.[12]];
  if (!worldPoints.every(point =>
    point && Number.isFinite(point.x) && Number.isFinite(point.y) && Number.isFinite(point.z)
  )) return { valid: false, reason: "깊이 좌표 없음", headTurn };

  const [leftEar3d, rightEar3d, leftShoulder3d, rightShoulder3d] = worldPoints;
  const shoulderDz = leftShoulder3d.z - rightShoulder3d.z;
  const shoulderWidth3d = Math.max(0.15, Math.hypot(
    leftShoulder3d.x - rightShoulder3d.x, leftShoulder3d.y - rightShoulder3d.y, shoulderDz));
  const torsoTurn = Math.abs(shoulderDz) / shoulderWidth3d;
  const headRoll = Math.atan2(rightEar.y - leftEar.y, Math.abs(rightEar.x - leftEar.x));

  // 2D cues in pixel-proportional units (x scaled by aspect), normalised by shoulder width,
  // so moving the whole body toward/away from the camera does not change them.
  const px = point => [point.x * aspect, point.y];
  const dist = (a, b) => Math.hypot(px(a)[0] - px(b)[0], px(a)[1] - px(b)[1]);
  const shoulderWidth2d = Math.max(0.05, dist(leftShoulder, rightShoulder));
  const neck = ((leftShoulder.y + rightShoulder.y) / 2 - (leftEar.y + rightEar.y) / 2) / shoulderWidth2d;
  const head = dist(leftEar, rightEar) / shoulderWidth2d;
  const depth = ((leftEar3d.z + rightEar3d.z) / 2 - (leftShoulder3d.z + rightShoulder3d.z) / 2) / shoulderWidth3d;
  return { valid: true, reason: "측정 중", headTurn, headRoll, torsoTurn, pose: { neck, head, depth } };
}

// One-sided: only movement toward slouching counts, so sitting up straighter or leaning back never blurs.
export function slouchDeviation(pose, base) {
  const neckDrop = Math.max(0, (base.neck - pose.neck) / Math.max(0.1, base.neck)); // head sinks toward shoulders
  const headGrow = Math.max(0, (pose.head - base.head) / Math.max(0.1, base.head)); // face comes toward camera
  const depthForward = Math.max(0, base.depth - pose.depth);                      // ears move in front of shoulders
  return neckDrop + HEAD_GROW_WEIGHT * headGrow + DEPTH_WEIGHT * depthForward;
}

export function deviationToScore(deviation) {
  return Math.max(0, Math.min(10, (deviation - DEVIATION_DEADZONE) / (DEVIATION_FULL - DEVIATION_DEADZONE) * 10));
}

const median = values => {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[sorted.length >> 1];
};

// Baseline from several frames: a single calibration frame carries the full landmark jitter.
export function medianFeatures(frames) {
  return {
    valid: true,
    headTurn: median(frames.map(f => f.headTurn)),
    headRoll: median(frames.map(f => f.headRoll)),
    torsoTurn: median(frames.map(f => f.torsoTurn)),
    pose: Object.fromEntries(Object.keys(frames[0].pose).map(key => [key, median(frames.map(f => f.pose[key]))]))
  };
}
