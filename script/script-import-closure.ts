import { cpSync, mkdirSync, readFileSync } from "node:fs"
import { builtinModules } from "node:module"
import { dirname, isAbsolute, join, relative, resolve } from "node:path"

const BUILTINS = new Set(builtinModules)

function isBuiltin(specifier: string): boolean {
  return specifier.startsWith("node:") || specifier.startsWith("bun:") || specifier === "bun" || BUILTINS.has(specifier)
}

/**
 * The files under `scriptDir` that running `entries` loads: every file reached through a static, require or
 * literal dynamic import, read from the real sources on each call, so an import added to a script is followed
 * the day it lands. A scratch repository holds only these files instead of the whole script/ tree. An import
 * that does not resolve, resolves outside `scriptDir`, or names a package (a scratch repository has no
 * node_modules) throws here instead of producing a scratch copy the script cannot load.
 */
function scriptImportClosure(entries: readonly string[], scriptDir: string = import.meta.dir): string[] {
  const root = resolve(scriptDir)
  const transpiler = new Bun.Transpiler({ loader: "ts" })
  const seen = new Set<string>()
  const pending = entries.map((entry) => resolve(root, entry))
  while (pending.length > 0) {
    const file = pending.pop()
    if (file === undefined || seen.has(file)) continue
    const inside = relative(root, file)
    if (inside.startsWith("..") || isAbsolute(inside)) throw new Error(`${file} is outside ${root}`)
    seen.add(file)
    const source = readFileSync(file, "utf8").replace(/^#![^\n]*/, "")
    for (const { path: specifier } of transpiler.scanImports(source)) {
      if (isBuiltin(specifier)) continue
      if (!specifier.startsWith(".")) throw new Error(`${inside} imports package ${specifier}`)
      pending.push(Bun.resolveSync(specifier, dirname(file)))
    }
  }
  return [...seen].map((file) => relative(root, file)).sort()
}

export function copyScriptImportClosure(
  entries: readonly string[],
  targetScriptDir: string,
  scriptDir: string = import.meta.dir,
): void {
  for (const file of scriptImportClosure(entries, scriptDir)) {
    mkdirSync(dirname(join(targetScriptDir, file)), { recursive: true })
    cpSync(join(scriptDir, file), join(targetScriptDir, file))
  }
}
