// Where the V2 host finds the desktop engine. It never downloads or ships one: it reuses the engine an OmO Native
// install already provisioned (the compiled runtime's sidecar under ~/.omo/binary-runtime/<version>/, or the
// verified release cache under ~/.omo/cache/senpi-desktop-engine/), or `computer.engine_path`. Locating,
// verifying and launching (including the macOS stable launch) are the shared senpi-desktop-engine functions.

import { accessSync, constants, existsSync, readdirSync, readFileSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"
import {
  type DesktopEngineLocateDiagnostic,
  desktopEngineReleaseAssetName,
  findCachedDesktopEngine,
  getDesktopEngineFileName,
  getDesktopEngineHost,
  isQuarantinedFile,
  launchDesktopEngine,
} from "@oh-my-opencode/senpi-desktop-engine"
import {
  type ChildFactory,
  DesktopEngineUnavailableError,
  engineChildFactory,
} from "@oh-my-opencode/senpi-desktop-service"

type Env = Readonly<Record<string, string | undefined>>

export const ENGINE_NOT_INSTALLED_ACTION =
  "Install or update OmO Native (https://omo.dev), which provisions the desktop engine, or set computer.engine_path in omo.json to a senpi-desktop-engine binary; then run /omo:computer status."

export interface EngineLocatorOptions {
  readonly env?: Env
  readonly home?: string
  readonly platform?: string
  readonly arch?: string
}

export type InstalledEngine =
  | { readonly kind: "explicit"; readonly path: string }
  | { readonly kind: "runtime"; readonly path: string; readonly version: string; readonly runtimeDir: string }
  | { readonly kind: "cache"; readonly path: string; readonly version: string }
  | { readonly kind: "missing"; readonly diagnostic: DesktopEngineLocateDiagnostic }

const VERSION = /^[0-9]+\.[0-9]+\.[0-9]+(?:[-+][0-9A-Za-z.-]+)?$/

function newestFirst(versions: readonly string[]): string[] {
  return versions.filter((version) => VERSION.test(version)).sort((a, b) => Bun.semver.order(b, a))
}

function listDirectory(path: string): string[] {
  try {
    return readdirSync(path)
  } catch (error) {
    if (error instanceof Error && "code" in error) return []
    throw error
  }
}

function omoRuntimeVersion(runtimeDir: string): string | undefined {
  try {
    const manifest: unknown = JSON.parse(readFileSync(join(runtimeDir, "package.json"), "utf8"))
    if (typeof manifest !== "object" || manifest === null) return undefined
    const version = Reflect.get(manifest, "version")
    return Reflect.get(manifest, "name") === "omo" && typeof version === "string" && VERSION.test(version)
      ? version
      : undefined
  } catch (error) {
    if (error instanceof Error && ("code" in error || error instanceof SyntaxError)) return undefined
    throw error
  }
}

function usable(path: string, platform: string): string | undefined {
  if (!existsSync(path)) return `${path}: missing`
  if (isQuarantinedFile(path, platform))
    return `${path}: blocked because com.apple.quarantine is present (macOS Gatekeeper)`
  // Windows has no exec bit (X_OK only proves existence there); the engine must be a .exe.
  if (platform === "win32") return /\.exe$/i.test(path) ? undefined : `${path}: not executable (expected a .exe file)`
  try {
    accessSync(path, constants.X_OK)
    return undefined
  } catch (error) {
    if (error instanceof Error && "code" in error) return `${path}: not executable (chmod +x)`
    throw error
  }
}

export function resolveInstalledEngine(
  enginePath: string | undefined,
  options: EngineLocatorOptions = {},
): InstalledEngine {
  const env = options.env ?? process.env
  const platform = options.platform ?? process.platform
  const host = getDesktopEngineHost(platform, options.arch)
  const home = options.home ?? homedir()
  const causes: string[] = []
  const attemptedPaths: string[] = []
  const missing = (message: string, cause: string): InstalledEngine => ({
    kind: "missing",
    diagnostic: { code: "native-unavailable", host, attemptedPaths, message, cause },
  })
  if (enginePath !== undefined) {
    attemptedPaths.push(enginePath)
    const problem = usable(enginePath, platform)
    return problem === undefined
      ? { kind: "explicit", path: enginePath }
      : missing(`The computer.engine_path desktop engine is not usable on ${host}.`, problem)
  }
  if (desktopEngineReleaseAssetName(host) === null) {
    return {
      kind: "missing",
      diagnostic: {
        code: "native-unavailable",
        host,
        attemptedPaths,
        reason: "no-release-asset",
        message: `No senpi-desktop-engine is built for ${host}; computer use is unavailable on this host.`,
        cause: "no release asset for this host",
      },
    }
  }
  const file = getDesktopEngineFileName(platform)
  const runtimeRoot = join(home, ".omo", "binary-runtime")
  const runtimeDirs = [
    ...(env.OMO_PACKAGE_DIR?.trim() ? [env.OMO_PACKAGE_DIR.trim()] : []),
    ...newestFirst(listDirectory(runtimeRoot)).map((version) => join(runtimeRoot, version)),
  ]
  for (const runtimeDir of runtimeDirs) {
    const version = omoRuntimeVersion(runtimeDir)
    const path = join(runtimeDir, "native", "prebuilds", host, file)
    attemptedPaths.push(path)
    if (version === undefined) {
      causes.push(`${runtimeDir}: not an OmO Native runtime`)
      continue
    }
    const problem = usable(path, platform)
    if (problem === undefined) return { kind: "runtime", path, version, runtimeDir }
    causes.push(problem)
  }
  const cacheDir = join(home, ".omo", "cache", "senpi-desktop-engine")
  for (const version of newestFirst(listDirectory(cacheDir))) {
    const cached = findCachedDesktopEngine({ host, version, cacheDir })
    if (cached.path !== null) return { kind: "cache", path: cached.path, version }
    attemptedPaths.push(...cached.attemptedPaths)
  }
  causes.push(`${runtimeRoot}: no installed runtime engine`, `${cacheDir}: no verified cached engine`)
  return missing(
    `No desktop engine installed by OmO Native was found for ${host}.`,
    `${causes.join("; ")}. ${ENGINE_NOT_INSTALLED_ACTION}`,
  )
}

export function installedEngineChild(enginePath: string | undefined, options: EngineLocatorOptions = {}): ChildFactory {
  return async () => {
    const source = resolveInstalledEngine(enginePath, options)
    if (source.kind === "missing") throw new DesktopEngineUnavailableError(source.diagnostic)
    if (source.kind === "explicit") return engineChildFactory(source.path)()
    const platform = options.platform ?? process.platform
    const home = options.home ?? homedir()
    const launched = await launchDesktopEngine(
      {
        version: source.version,
        host: getDesktopEngineHost(platform, options.arch),
        allowDownload: false,
        cacheDir: join(home, ".omo", "cache", "senpi-desktop-engine"),
        installDir: join(home, ".omo", "engines", "senpi-desktop-engine"),
        locatorOptions: {
          platform,
          ...(options.arch === undefined ? {} : { arch: options.arch }),
          runtimeDir: source.kind === "runtime" ? source.runtimeDir : "",
        },
      },
      (path) => engineChildFactory(path)(),
    )
    if (launched.path === null) throw new DesktopEngineUnavailableError(launched.diagnostic)
    return launched.value
  }
}

export function describeInstalledEngine(source: InstalledEngine): string {
  switch (source.kind) {
    case "explicit":
      return `found ${source.path} (computer.engine_path)`
    case "runtime":
      return `found ${source.path} (OmO Native v${source.version})`
    case "cache":
      return `found ${source.path} (OmO Native engine cache, v${source.version})`
    case "missing":
      return source.diagnostic.reason === "no-release-asset"
        ? source.diagnostic.message
        : `${source.diagnostic.message} ${source.diagnostic.cause}`
  }
}
