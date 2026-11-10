import type {
  CheckResult,
  CommentCheckerReleaseAsset,
  InstalledCommentCheckerBinaryOptions,
  RunCommentCheckerInput,
} from "@oh-my-opencode/comment-checker-core"

import type { ComponentContext } from "../../extension/types"

export type {
  ToolResultContentBlock,
  ToolResultContextLike,
  ToolResultEventLike,
  ToolResultTextBlock,
} from "@oh-my-opencode/comment-checker-core"

export interface CommentCheckerComponentOptions {
  resolveBinary?: () => string | null
  /** Runs once per session when {@link resolveBinary} finds nothing; null keeps the component disabled. */
  downloadBinary?: (logger: ComponentContext["logger"]) => Promise<string | null>
  runCommentChecker?: (input: RunCommentCheckerInput) => Promise<CheckResult>
}

export interface SenpiCommentCheckerBinaryResolverOptions extends Omit<InstalledCommentCheckerBinaryOptions, "importMetaUrl"> {
  readonly importMetaUrl?: string
}

export interface SenpiCommentCheckerDownloadOptions {
  readonly logger: ComponentContext["logger"]
  readonly platform?: NodeJS.Platform
  readonly arch?: string
  readonly cacheDir?: string
  /** Tests point the pinned asset at a local server; production downloads from the release URL. */
  readonly resolveAssetUrl?: (asset: CommentCheckerReleaseAsset) => string
}
