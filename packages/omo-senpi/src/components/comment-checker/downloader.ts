import { downloadCommentCheckerBinary, type CommentCheckerArchiveOps } from "@oh-my-opencode/comment-checker-core"
import {
  cleanupArchive,
  downloadArchive,
  ensureCacheDir,
  ensureExecutable,
  extractTarGz,
  extractZipArchive,
} from "@oh-my-opencode/omo-opencode/binary-downloader"

import { COMMENT_CHECKER_LOG_LABEL } from "./constants"
import type { SenpiCommentCheckerDownloadOptions } from "./types"

const archive: CommentCheckerArchiveOps = {
  ensureCacheDir,
  downloadArchive,
  extractTarGz,
  extractZipArchive,
  ensureExecutable,
  cleanupArchive,
}

export async function downloadSenpiCommentCheckerBinary(
  options: SenpiCommentCheckerDownloadOptions,
): Promise<string | null> {
  return downloadCommentCheckerBinary({ ...options, logLabel: COMMENT_CHECKER_LOG_LABEL, archive })
}
