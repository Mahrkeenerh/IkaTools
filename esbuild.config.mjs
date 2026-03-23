import { build } from "esbuild";
import { cpSync, rmSync, readdirSync } from "fs";

// Clean dist
rmSync("dist", { recursive: true, force: true });

// Bundle offscreen.js with onnxruntime-web
await build({
  entryPoints: ["src/offscreen.js"],
  bundle: true,
  outfile: "dist/offscreen.bundle.js",
  format: "esm",
  target: "chrome120",
  platform: "browser",
});

// Copy all WASM runtime files
const ortDist = "node_modules/onnxruntime-web/dist/";
for (const f of readdirSync(ortDist)) {
  if (f.startsWith("ort-wasm-simd-threaded")) {
    cpSync(ortDist + f, "dist/" + f);
  }
}

console.log("Build complete.");
