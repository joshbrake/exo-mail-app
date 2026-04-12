#!/usr/bin/env node
/**
 * Build script for the Asana extension as a distributable .zip.
 *
 * Produces:
 *   dist/main.js       - Main process entry point (Node.js CJS)
 *   dist/renderer.js   - React panel component (ESM, React externalized)
 *   package.json        - Extension manifest (with builtIn: false)
 *
 * Then zips everything into mail-ext-asana-<version>.zip ready for installation
 * via Settings → Extensions → Install.
 *
 * Usage:
 *   node build.mjs                   # Build only
 *   node build.mjs --zip             # Build + create .zip
 */

import { build } from "esbuild";
import { readFileSync, writeFileSync, mkdirSync, existsSync, cpSync, rmSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { execSync } from "child_process";

const __dirname = dirname(fileURLToPath(import.meta.url));
const outDir = join(__dirname, "dist");
const stageDir = join(__dirname, ".stage");
const shouldZip = process.argv.includes("--zip");

// Clean output directories
for (const dir of [outDir, stageDir]) {
  if (existsSync(dir)) rmSync(dir, { recursive: true });
  mkdirSync(dir, { recursive: true });
}

// Read the source package.json
const pkg = JSON.parse(readFileSync(join(__dirname, "package.json"), "utf-8"));

console.log(`Building ${pkg.name} v${pkg.version}...`);

// Shared esbuild options
const shared = {
  bundle: true,
  sourcemap: false,
  minify: true,
  target: "es2022",
  // Resolve paths relative to the monorepo src/
  alias: {
    // The extension imports from ../../../shared/* and ../../../main/*
    // which are resolved relative to the source tree at build time
  },
};

// 1. Build main process bundle (CJS for Node.js / createRequire)
await build({
  ...shared,
  entryPoints: [join(__dirname, "src/index.ts")],
  outfile: join(outDir, "main.js"),
  platform: "node",
  format: "cjs",
  external: [
    "electron",
    // These are provided by the host app at runtime via createRequire
  ],
});

console.log("  ✓ dist/main.js (main process)");

// 2. Build renderer bundle (ESM with React externalized)
await build({
  ...shared,
  entryPoints: [join(__dirname, "src/renderer/index.ts")],
  outfile: join(outDir, "renderer.js"),
  platform: "browser",
  format: "esm",
  external: [
    "react",
    "react-dom",
    "react/jsx-runtime",
  ],
  // The renderer index.ts imports React components — JSX needs to be transformed
  jsx: "automatic",
});

console.log("  ✓ dist/renderer.js (renderer panels)");

// 3. Create distributable package.json (builtIn: false, point main to dist/)
const distPkg = {
  name: pkg.name,
  version: pkg.version,
  description: pkg.description,
  main: "./dist/main.js",
  mailExtension: {
    ...pkg.mailExtension,
    builtIn: false,
  },
};

writeFileSync(join(stageDir, "package.json"), JSON.stringify(distPkg, null, 2) + "\n");
cpSync(outDir, join(stageDir, "dist"), { recursive: true });

console.log("  ✓ package.json (manifest)");

// 4. Create .zip if requested
if (shouldZip) {
  const zipName = `${pkg.name}-${pkg.version}.zip`;
  const zipPath = join(__dirname, zipName);

  // Remove old zip if it exists
  if (existsSync(zipPath)) rmSync(zipPath);

  // Create zip from the staging directory
  execSync(`cd "${stageDir}" && zip -r "${zipPath}" .`, { stdio: "inherit" });

  // Clean up staging directory
  rmSync(stageDir, { recursive: true });

  console.log(`\n📦 ${zipName} created`);
  console.log(`   Install via: Settings → Extensions → Install Extension`);
} else {
  // Clean up staging directory
  rmSync(stageDir, { recursive: true });
  console.log("\nBuild complete. Run with --zip to create distributable archive.");
}
