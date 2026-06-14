const fs = require("fs");
const path = require("path");

const root = path.resolve(".");
const srcDir = path.join(root, "src");
const outDir = path.join(root, "dist");

const COPY_EXT = new Set([".html", ".json", ".png", ".svg"]);

function ensureDir(dir) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function copyDir(src, dest, label) {
  if (!fs.existsSync(src)) {
    console.log(`  [skip] ${label}: source not found`);
    return;
  }
  const files = fs.readdirSync(src);
  if (files.length === 0) return;
  console.log(`  [copy] ${label} → ${path.relative(root, dest)}/ (${files.length} items)`);
  for (const file of files) {
    const srcPath = path.join(src, file);
    const stat = fs.statSync(srcPath);
    if (stat.isDirectory()) {
      const newDest = path.join(dest, file);
      ensureDir(newDest);
      copyDir(srcPath, newDest, `${label}/${file}`);
    } else if (COPY_EXT.has(path.extname(file))) {
      ensureDir(dest);
      fs.copyFileSync(srcPath, path.join(dest, file));
      console.log(`         + ${file}`);
    }
  }
}

function main() {
  ensureDir(outDir);

  copyDir(path.join(root, "icons"), path.join(outDir, "icons"), "icons");
  copyDir(srcDir, outDir, "src");

  const manifestSrc = path.join(root, "manifest.json");
  if (fs.existsSync(manifestSrc)) {
    fs.copyFileSync(manifestSrc, path.join(outDir, "manifest.json"));
    console.log("  [copy] manifest.json");
  }

  console.log("Assets copied → dist/");
}

main();
