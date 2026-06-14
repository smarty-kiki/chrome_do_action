const fs = require("fs");
const path = require("path");

const distDir = path.resolve(".");

// Read all compiled JS in dependency order
const files = [
  "dist/ws/types.js",
  "dist/ws/client.js",
  "dist/background/service-worker.js",
  "dist/content/content-script.js",
  "dist/popup/popup.js",
  "dist/options/options.js",
];

// Remove import/export lines and concatenate
const merged = [];
for (const f of files) {
  const full = path.join(distDir, f);
  if (!fs.existsSync(full)) {
    console.log(`  [skip] ${f} (not found)`);
    continue;
  }
  let code = fs.readFileSync(full, "utf-8");
  code = code
    .split("\n")
    .filter((l) => !l.match(/^(import |export )/))
    .join("\n");
  merged.push(`// ===== ${f} =====\n${code}\n`);
}

// Write merged versions
const write = (rel, content) => {
  const out = path.join(distDir, rel);
  fs.writeFileSync(out, content, "utf-8");
};

write("dist/background/service-worker.js", merged[0] + merged[1] + merged[2]);
write("dist/content/content-script.js", merged[0] + merged[3]);
write("dist/popup/popup.js", merged[0] + merged[4]);
write("dist/options/options.js", merged[0] + merged[5]);

console.log("Bundled JS files (no imports)");
