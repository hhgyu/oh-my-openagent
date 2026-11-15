import { existsSync } from "node:fs"
import { delimiter, extname, isAbsolute, join, resolve } from "node:path"

const DEFAULT_WINDOWS_PATHEXT = ".COM;.EXE;.BAT;.CMD"

export function executableNames(bin, platform = process.platform, pathExt = process.env.PATHEXT) {
  if (platform !== "win32" || extname(bin) !== "") return [bin]
  const extensions = (pathExt?.trim() || DEFAULT_WINDOWS_PATHEXT)
    .split(";")
    .map((extension) => extension.trim())
    .filter((extension) => extension.length > 0)
  return [bin, ...extensions.map((extension) => `${bin}${extension}`)]
}

export function resolveSenpiBin({
  env = process.env,
  cwd = process.cwd(),
  platform = process.platform,
  exists = existsSync,
} = {}) {
  const bin = env.SENPI_BIN?.trim() || "senpi"
  const names = (candidate) => executableNames(candidate, platform, env.PATHEXT)
  if (isAbsolute(bin) || bin.includes("/") || bin.includes("\\")) {
    for (const candidate of names(bin)) {
      const absolute = resolve(cwd, candidate)
      if (exists(absolute)) return absolute
    }
    return null
  }
  const searchDirs = [join(cwd, "node_modules", ".bin"), ...(env.PATH ?? "").split(delimiter)]
  for (const dir of new Set(searchDirs)) {
    for (const name of names(bin)) {
      const candidate = resolve(cwd, dir || ".", name)
      if (exists(candidate)) return candidate
    }
  }
  return null
}
