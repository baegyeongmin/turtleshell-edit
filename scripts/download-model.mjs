import { mkdir } from "node:fs/promises";
import { createWriteStream } from "node:fs";
import { pipeline } from "node:stream/promises";
import https from "node:https";

const url = "https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_lite/float16/1/pose_landmarker_lite.task";
const dir = new URL("../public/models/", import.meta.url);
await mkdir(dir, { recursive: true });
const output = new URL("../public/models/pose_landmarker_lite.task", import.meta.url);

await new Promise((resolve, reject) => {
  https.get(url, response => {
    if (response.statusCode !== 200) {
      reject(new Error(`Model download failed: HTTP ${response.statusCode}`));
      response.resume();
      return;
    }
    pipeline(response, createWriteStream(output)).then(resolve, reject);
  }).on("error", reject);
});
console.log("Downloaded pose_landmarker_lite.task");
