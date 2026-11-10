#!/usr/bin/env bun

import { readFileSync, readdirSync, writeFileSync } from "node:fs"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url))
const DIST_DIR = resolve(process.argv[2] ?? join(SCRIPT_DIR, "..", "dist"))
const IMPORT_LINE = 'import { createRequire as __omoCreateRequire } from "node:module";'
const BUN_REQUIRE_LINE = "var __require = import.meta.require;"
const NODE_SAFE_REQUIRE_LINE = 'var __require = typeof import.meta.require === "function" ? import.meta.require : __omoCreateRequire(import.meta.url);'

// Splitting can move Bun's helper into a shared or lazy chunk. Patch only the
// OpenCode entry/chunk directories; CLI and other product builds are independent.
for (const directory of [DIST_DIR, join(DIST_DIR, "v2")]) {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (!entry.isFile() || !(entry.name === "index.js" || /^opencode-.*\.js$/.test(entry.name))) continue
    const path = join(directory, entry.name)
    const original = readFileSync(path, "utf-8")
    if (original.includes(NODE_SAFE_REQUIRE_LINE) || !original.includes(BUN_REQUIRE_LINE)) continue
    writeFileSync(path, original.replace(BUN_REQUIRE_LINE, `${IMPORT_LINE}\n${NODE_SAFE_REQUIRE_LINE}`), "utf-8")
    console.log(`Patched Node/Electron require shim in ${path}`)
  }
}
