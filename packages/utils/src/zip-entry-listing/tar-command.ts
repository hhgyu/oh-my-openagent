import { existsSync } from "node:fs"
import { win32 } from "node:path"

/**
 * The tar to spawn for archive listing and extraction.
 *
 * Windows ships bsdtar as System32\tar.exe, and the listing parsers and zip extraction rely on it. A bare `tar`
 * resolves through PATH instead, where Git for Windows' usr/bin often comes first: its GNU tar reads `C:\...` as a
 * remote `host:path` and cannot open a zip, so every Windows extraction failed. POSIX keeps the PATH lookup.
 */
export function resolveTarCommand(
  platform: NodeJS.Platform = process.platform,
  env: NodeJS.ProcessEnv = process.env,
  exists: (path: string) => boolean = existsSync,
): string {
  if (platform !== "win32") return "tar"
  const systemRoot = env.SystemRoot ?? env.SYSTEMROOT ?? env.windir ?? env.WINDIR ?? "C:\\Windows"
  const systemTar = win32.join(systemRoot, "System32", "tar.exe")
  return exists(systemTar) ? systemTar : "tar"
}
