const fs = require("fs");
const path = require("path");

const manifestPath = path.join(path.resolve("."), "dist", "manifest.json");
if (!fs.existsSync(manifestPath)) {
  console.log("No manifest.json found, skipping.");
  process.exit(0);
}

let content = fs.readFileSync(manifestPath, "utf-8");

// tsc outputs to dist/ without src/ prefix, but manifest references src/...
// Strip "src/" prefix from all paths in manifest
content = content.replace(/"src\//g, '"');

fs.writeFileSync(manifestPath, content, "utf-8");
console.log("Manifest paths rewritten (src/ prefix removed)");
