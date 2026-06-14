const fs = require("fs");
const path = require("path");
const esbuild = require("esbuild");

const root = path.resolve(".");
const outDir = path.join(root, "dist");

function ensureDir(dir) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function copyHtmlFiles(src, dest) {
  if (!fs.existsSync(src)) return;
  for (const file of fs.readdirSync(src)) {
    const srcPath = path.join(src, file);
    const stat = fs.statSync(srcPath);
    if (stat.isDirectory()) {
      const newDest = path.join(dest, file);
      ensureDir(newDest);
      copyHtmlFiles(srcPath, newDest);
    } else if (path.extname(file) === ".html") {
      fs.copyFileSync(srcPath, path.join(dest, file));
    }
  }
}

function copyDir(src, dest) {
  if (!fs.existsSync(src)) return;
  for (const file of fs.readdirSync(src)) {
    const srcPath = path.join(src, file);
    const stat = fs.statSync(srcPath);
    if (stat.isDirectory()) {
      copyDir(srcPath, path.join(dest, file));
    } else {
      ensureDir(dest);
      fs.copyFileSync(srcPath, path.join(dest, file));
    }
  }
}

const build = async () => {
  // Clean output
  if (fs.existsSync(outDir)) {
    fs.rmSync(outDir, { recursive: true });
  }
  ensureDir(outDir);

  // Bundle each entry point with esbuild (no imports in output)
  const entries = [
    { src: "src/background/service-worker.ts", out: "dist/background/service-worker.js" },
    { src: "src/content/content-script.ts",   out: "dist/content/content-script.js" },
    { src: "src/popup/popup.ts",              out: "dist/popup/popup.js" },
    { src: "src/options/options.ts",          out: "dist/options/options.js" },
  ];

  for (const entry of entries) {
    await esbuild.build({
      entryPoints: [path.join(root, entry.src)],
      bundle: true,
      format: "iife",
      target: "chrome120",
      outfile: path.join(root, entry.out),
      logLevel: "silent",
    });
    console.log(`  [bundle] ${entry.src} → ${entry.out}`);
  }

  // Copy static assets
  copyDir(path.join(root, "icons"), path.join(outDir, "icons"));

  const manifestSrc = path.join(root, "manifest.json");
  fs.copyFileSync(manifestSrc, path.join(outDir, "manifest.json"));
  console.log("  [copy] manifest.json, icons/");

  // Copy HTML files from src/ to dist/
  copyHtmlFiles(path.join(root, "src"), outDir);
  console.log("  [copy] HTML files from src/");

  // Rewrite manifest paths
  const manifestPath = path.join(outDir, "manifest.json");
  let manifest = fs.readFileSync(manifestPath, "utf-8");
  manifest = manifest.replace(/"src\//g, '"');
  fs.writeFileSync(manifestPath, manifest, "utf-8");
  console.log("  [fix] manifest paths");
};

build().catch((e) => {
  console.error(e);
  process.exit(1);
});
