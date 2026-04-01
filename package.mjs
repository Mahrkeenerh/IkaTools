// Package extension into a release zip (run via: npm run package)
import { execSync } from "child_process";
import { readFileSync } from "fs";

const manifest = JSON.parse(readFileSync("manifest.json", "utf8"));
const version = manifest.version;
const outFile = `ikariam-tools-v${version}.zip`;

// Include only what the extension needs at runtime
execSync(`zip -r ${outFile} \
  manifest.json \
  *.js \
  *.html \
  icons/ \
  model/model.onnx \
  dist/ \
  README.md \
  -x "esbuild.config.mjs" "package.mjs" "node_modules/*" ".git/*" "*.md" "!README.md"`, {
  stdio: "inherit",
});

console.log(`\nPackaged: ${outFile}`);
