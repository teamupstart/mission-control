#!/usr/bin/env node
// Regenerate the macOS app icon (.icns) and the menu-bar tray template PNGs from
// the source SVGs in build/. The generated binaries are committed so packaging
// never needs an image toolchain; run this only when the SVGs change.
//
// Requires `rsvg-convert` (brew install librsvg) and `iconutil` (ships with macOS).
//
// Usage: node scripts/gen-icons.mjs

import { execFileSync } from "node:child_process";
import { mkdirSync, rmSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const repo = join(dirname(fileURLToPath(import.meta.url)), "..");
const buildDir = join(repo, "build");
const appSvg = join(buildDir, "app-icon.svg");
const traySvg = join(buildDir, "tray-icon.svg");

function have(bin) {
  try {
    execFileSync(bin, ["--version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

function render(svg, size, out) {
  execFileSync("rsvg-convert", ["-w", String(size), "-h", String(size), svg, "-o", out], {
    stdio: "inherit",
  });
}

if (!have("rsvg-convert")) {
  console.error("rsvg-convert not found. Install with: brew install librsvg");
  process.exit(1);
}

// --- app icon: build an .iconset then fold to .icns -------------------------
const iconset = join(buildDir, "icon.iconset");
rmSync(iconset, { recursive: true, force: true });
mkdirSync(iconset, { recursive: true });

// macOS expects these named sizes (1x + 2x for each logical size).
const specs = [
  [16, "icon_16x16.png"],
  [32, "icon_16x16@2x.png"],
  [32, "icon_32x32.png"],
  [64, "icon_32x32@2x.png"],
  [128, "icon_128x128.png"],
  [256, "icon_128x128@2x.png"],
  [256, "icon_256x256.png"],
  [512, "icon_256x256@2x.png"],
  [512, "icon_512x512.png"],
  [1024, "icon_512x512@2x.png"],
];
for (const [size, name] of specs) render(appSvg, size, join(iconset, name));

execFileSync("iconutil", ["-c", "icns", iconset, "-o", join(buildDir, "icon.icns")], {
  stdio: "inherit",
});
rmSync(iconset, { recursive: true, force: true });
console.log("wrote build/icon.icns");

// --- tray template (monochrome; Electron recolors for light/dark) -----------
render(traySvg, 16, join(buildDir, "trayTemplate.png"));
render(traySvg, 32, join(buildDir, "trayTemplate@2x.png"));
console.log("wrote build/trayTemplate.png + @2x");

if (!existsSync(join(buildDir, "icon.icns"))) {
  console.error("icon.icns missing after generation");
  process.exit(1);
}
