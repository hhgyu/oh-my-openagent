import {
  downloadCommentCheckerBinary,
  resolveInstalledCommentCheckerBinary,
  type CommentCheckerArchiveOps,
  type CommentCheckerLogger,
} from "@oh-my-opencode/comment-checker-core"
import {
  cleanupArchive,
  downloadArchive,
  ensureCacheDir,
  ensureExecutable,
  extractTarGz,
  extractZipArchive,
} from "../../../shared/binary-downloader"

export const V2_COMMENT_CHECKER_LOG_LABEL = "comment-checker"

const archive: CommentCheckerArchiveOps = {
  ensureCacheDir,
  downloadArchive,
  extractTarGz,
  extractZipArchive,
  ensureExecutable,
  cleanupArchive,
}

/** Env override, package API, PATH, then the shared cache slot every edition downloads into. */
export function resolveV2CommentCheckerBinary(): string | null {
  return resolveInstalledCommentCheckerBinary({ importMetaUrl: import.meta.url })
}

export function downloadV2CommentCheckerBinary(logger: CommentCheckerLogger): Promise<string | null> {
  return downloadCommentCheckerBinary({ logger, logLabel: V2_COMMENT_CHECKER_LOG_LABEL, archive })
}
