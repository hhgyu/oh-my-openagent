import { accessSync, constants, existsSync } from "node:fs"
import { createRequire } from "node:module"
import { homedir } from "node:os"
import { delimiter, isAbsolute, join } from "node:path"

import { isCachedCommentCheckerCurrent } from "./cached-release"
import { COMMENT_CHECKER_PACKAGE_NAME } from "./package-binary"
import { commentCheckerBinaryName, commentCheckerCacheDir } from "./release"

const COMMENT_CHECKER_ENV_KEY = "OMO_COMMENT_CHECKER_BIN"
// Must equal the OpenCode edition's CACHE_DIR_NAME (omo-opencode shared/plugin-identity.ts) so one
// downloaded binary serves every edition; the Native downloader test pins the equality.
export const COMMENT_CHECKER_CACHE_DIR_NAME = "oh-my-opencode"

export interface InstalledCommentCheckerBinaryOptions {
  readonly env?: Record<string, string | undefined>
  readonly existsSync?: (path: string) => boolean
  /** Module URL the `@code-yeongyu/comment-checker` package is resolved from (the calling adapter's own). */
  readonly importMetaUrl: string
  readonly requireModule?: (moduleName: string) => unknown
  readonly pathLookup?: (binaryName: string) => string | null | undefined
  readonly platform?: NodeJS.Platform
  readonly cacheDir?: string
}

/** Env override, then the package API, then PATH, then the shared cache slot when it holds the pinned release. */
export function resolveInstalledCommentCheckerBinary(options: InstalledCommentCheckerBinaryOptions): string | null {
  const checkExists = options.existsSync ?? existsSync
  const env = options.env ?? process.env
  const envBinaryPath = env[COMMENT_CHECKER_ENV_KEY]?.trim()
  if (envBinaryPath !== undefined && envBinaryPath.length > 0 && isAbsolute(envBinaryPath) && checkExists(envBinaryPath)) {
    return envBinaryPath
  }

  const fromPackageApi = resolvePackageApiBinary({
    existsSync: checkExists,
    importMetaUrl: options.importMetaUrl,
    requireModule: options.requireModule,
  })
  if (fromPackageApi !== null) {
    return fromPackageApi
  }

  const platform = options.platform ?? process.platform
  const binaryName = commentCheckerBinaryName(platform)
  const pathLookup = options.pathLookup ?? findExecutableOnPath
  const fromPath = pathLookup(binaryName)
  if (fromPath) return fromPath

  const cacheDir = options.cacheDir ?? defaultCommentCheckerCacheDir(platform, env)
  const cached = join(cacheDir, binaryName)
  // An unrecorded or older checker in the shared slot is left for the downloader to replace (#8850).
  return checkExists(cached) && isCachedCommentCheckerCurrent(cacheDir) ? cached : null
}

export function defaultCommentCheckerCacheDir(
  platform: NodeJS.Platform = process.platform,
  env: Record<string, string | undefined> = process.env,
  cacheDirName: string = COMMENT_CHECKER_CACHE_DIR_NAME,
): string {
  return commentCheckerCacheDir({ platform, env, homedir: homedir(), cacheDirName })
}

function findExecutableOnPath(binaryName: string): string | null {
  const pathValue = process.env.PATH
  if (!pathValue) return null
  for (const directory of pathValue.split(delimiter)) {
    if (!directory) continue
    const candidate = join(directory, binaryName)
    if (isExecutableFile(candidate)) return candidate
  }
  return null
}

function isExecutableFile(path: string): boolean {
  if (!existsSync(path)) return false
  try {
    accessSync(path, constants.X_OK)
    return true
  } catch {
    return false
  }
}

interface PackageApiBinaryResolverInput {
  readonly existsSync: (path: string) => boolean
  readonly importMetaUrl: string
  readonly requireModule?: (moduleName: string) => unknown
}

function resolvePackageApiBinary(input: PackageApiBinaryResolverInput): string | null {
  try {
    const requireModule = input.requireModule ?? createRequire(input.importMetaUrl)
    const packageExports = requireModule(COMMENT_CHECKER_PACKAGE_NAME)
    if (!isCommentCheckerPackage(packageExports)) {
      return null
    }
    const binaryPath = packageExports.getBinaryPath()
    return input.existsSync(binaryPath) ? binaryPath : null
  } catch (error) {
    if (isMissingModuleValue(error)) {
      return null
    }
    throw error
  }
}

function isObjectRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null
}

function isCommentCheckerPackage(value: unknown): value is { getBinaryPath: () => string } {
  return isObjectRecord(value) && typeof value["getBinaryPath"] === "function"
}

// Bun 1.3.x throws a ResolveMessage for a missing module; it carries MODULE_NOT_FOUND but is not an
// Error instance (Bun 1.4.0 made it one). Node and later Bun throw a real Error, which is also missing.
function isMissingModuleValue(value: unknown): boolean {
  if (value instanceof Error) return true
  return isObjectRecord(value) && (value["code"] === "MODULE_NOT_FOUND" || value["name"] === "ResolveMessage")
}
