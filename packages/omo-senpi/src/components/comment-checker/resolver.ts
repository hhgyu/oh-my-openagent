import {
  defaultCommentCheckerCacheDir,
  resolveInstalledCommentCheckerBinary,
} from "@oh-my-opencode/comment-checker-core"

import type { SenpiCommentCheckerBinaryResolverOptions } from "./types"

export { defaultCommentCheckerCacheDir }

export function resolveSenpiCommentCheckerBinary(
  options: SenpiCommentCheckerBinaryResolverOptions = {},
): string | null {
  // The package API resolves from this adapter's own location, exactly as before the Core move.
  return resolveInstalledCommentCheckerBinary({ ...options, importMetaUrl: options.importMetaUrl ?? import.meta.url })
}
