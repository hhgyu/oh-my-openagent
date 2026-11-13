import { existsSync } from "node:fs"
import { join } from "node:path"

import { isCachedCommentCheckerCurrent, recordCachedCommentCheckerRelease } from "./cached-release"
import { defaultCommentCheckerCacheDir } from "./installed-binary"
import type { CommentCheckerLogger } from "./logger"
import {
  COMMENT_CHECKER_RELEASE_VERSION,
  commentCheckerBinaryName,
  resolveCommentCheckerReleaseAsset,
  type CommentCheckerReleaseAsset,
} from "./release"

/** Archive I/O the host supplies (fetch, tar/zip extraction, chmod); Core only sequences it. */
export interface CommentCheckerArchiveOps {
  ensureCacheDir(cacheDir: string): void
  downloadArchive(url: string, archivePath: string): Promise<void>
  extractTarGz(archivePath: string, destDir: string): Promise<void>
  extractZipArchive(archivePath: string, destDir: string): Promise<void>
  ensureExecutable(binaryPath: string): void
  cleanupArchive(archivePath: string): void
}

export interface DownloadCommentCheckerBinaryOptions {
  readonly logger: CommentCheckerLogger
  /** Prefix of every log message, e.g. "omo-senpi comment-checker". */
  readonly logLabel: string
  readonly archive: CommentCheckerArchiveOps
  readonly platform?: NodeJS.Platform
  readonly arch?: string
  readonly cacheDir?: string
  /** Tests point the pinned asset at a local server; production downloads from the release URL. */
  readonly resolveAssetUrl?: (asset: CommentCheckerReleaseAsset) => string
}

export async function downloadCommentCheckerBinary(
  options: DownloadCommentCheckerBinaryOptions,
): Promise<string | null> {
  const { archive, logLabel } = options
  const platform = options.platform ?? process.platform
  const arch = options.arch ?? process.arch
  const asset = resolveCommentCheckerReleaseAsset(platform, arch)
  if (asset === null) {
    options.logger.warn(`${logLabel} has no pinned release for this platform`, { platform, arch })
    return null
  }

  const cacheDir = options.cacheDir ?? defaultCommentCheckerCacheDir(platform)
  const binaryPath = join(cacheDir, commentCheckerBinaryName(platform))
  if (existsSync(binaryPath) && isCachedCommentCheckerCurrent(cacheDir)) return binaryPath

  const url = options.resolveAssetUrl?.(asset) ?? asset.url
  const archivePath = join(cacheDir, asset.assetName)
  options.logger.info(`${logLabel}: downloading release v${COMMENT_CHECKER_RELEASE_VERSION}`, { url, cacheDir })
  try {
    archive.ensureCacheDir(cacheDir)
    await archive.downloadArchive(url, archivePath)
    if (asset.ext === "tar.gz") {
      await archive.extractTarGz(archivePath, cacheDir)
    } else {
      await archive.extractZipArchive(archivePath, cacheDir)
    }
    archive.ensureExecutable(binaryPath)
    if (!existsSync(binaryPath)) {
      options.logger.warn(`${logLabel} archive did not contain the expected binary`, { archivePath, binaryPath })
      return null
    }
    recordCachedCommentCheckerRelease(cacheDir)
    return binaryPath
  } catch (error) {
    options.logger.warn(`${logLabel} download failed`, {
      url,
      error: error instanceof Error ? error.message : String(error),
    })
    return null
  } finally {
    archive.cleanupArchive(archivePath)
  }
}
