import { defineConfig } from "vite";
import { resolve } from "node:path";
import { cpSync, existsSync, mkdirSync } from "node:fs";

export default defineConfig({
  publicDir: "public",
  plugins: [{
    name: "copy-mediapipe-wasm",
    closeBundle() {
      const source = resolve("node_modules/@mediapipe/tasks-vision/wasm");
      const target = resolve("dist/assets/wasm");
      if (existsSync(source)) {
        mkdirSync(target, { recursive: true });
        cpSync(source, target, { recursive: true });
      }
    }
  }],
  build: {
    outDir: "dist",
    emptyOutDir: true,
    rollupOptions: { input: { sidepanel: resolve("sidepanel.html") } }
  }
});
