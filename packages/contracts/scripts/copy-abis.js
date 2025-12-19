const fs = require("fs");
const path = require("path");

const srcDir = path.join(__dirname, "..", "src", "abis");
const outDir = path.join(__dirname, "..", "dist", "abis");

if (!fs.existsSync(srcDir)) {
  throw new Error(`ABI source directory missing: ${srcDir}`);
}

fs.mkdirSync(outDir, { recursive: true });

const entries = fs.readdirSync(srcDir);
for (const entry of entries) {
  if (!entry.endsWith(".json")) continue;
  const from = path.join(srcDir, entry);
  const to = path.join(outDir, entry);
  fs.copyFileSync(from, to);
}

console.log(`Copied ABI JSONs to ${outDir}`);
