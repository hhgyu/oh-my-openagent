// Host-neutral seams for the memory slash-command handlers.
//
// Handlers receive a structural command context (only the fields the suite reads)
// and return the rendered text; every user-visible line is ALSO pushed through
// ctx.ui.notify when the host has a UI. Each harness adapts its own command
// surface onto these shapes and decides how the returned text reaches the user.

import type { GitExec, MemoryHookChecker, MemoryIdentityPaths } from "../index"
import { redactSecretLikeMaterial } from "../index"
import type { TranscriptProvider } from "../search"

export type NotifyLevel = "info" | "warning" | "error"

export interface MemoryCommandUi {
  notify(message: string, level?: NotifyLevel): void
  confirm?(title: string, message: string): Promise<boolean>
  select?(title: string, options: string[]): Promise<string | undefined>
}

/** Structural slice of a harness command context the memory commands read. */
export interface MemoryCommandContext {
  readonly mode?: string
  readonly hasUI?: boolean
  readonly cwd?: string
  readonly agentDir?: string
  readonly ui?: MemoryCommandUi
  readonly sessionManager?: { getSessionId(): string }
  /** senpi's live model registry; `/people --ask` resolves its quick child through it. */
  readonly modelRegistry?: unknown
  waitForIdle?(): Promise<void>
}

export type MemoryCommandHandler = (args: string, ctx: MemoryCommandContext) => Promise<string>

export interface MemoryCommandIdentity {
  readonly identity: string
  readonly identityPaths: MemoryIdentityPaths
}

/** Where `/search` reads transcripts from, or the actionable reason it cannot. */
export type MemoryTranscriptSource =
  | { readonly provider: TranscriptProvider }
  | { readonly error: string }

export interface MemoryCommandDeps {
  /** Bound identity for a session; undefined when the session has no memory binding. */
  contextForSession(sessionId: string): MemoryCommandIdentity | undefined
  /** Config-resolved identity for `/memfs init`, which may run before any binding exists. */
  resolveIdentity?(): MemoryCommandIdentity | undefined
  /** Prompt-assembly cache seam: busting makes the next agent run recompile from HEAD. */
  bustPromptCache(): void
  /** Senpi sessions root for `/search`; defaults to <agentDir>/sessions. */
  sessionsDir?(): string
  /** Host transcript source for `/search`; when absent `/search` scans senpi session JSONL. */
  transcriptSource?(ctx: MemoryCommandContext): MemoryTranscriptSource
  /**
   * Starts a model turn carrying `text` (`/remember`, `/init`). Absent means the host cannot start
   * one, and those commands report it instead of writing anything.
   */
  sendUserMessage?(text: string): void | Promise<void>
  /** Staged-commit checker the memory git hooks run; absent installs the default hooks. */
  hookChecker?(): MemoryHookChecker
  /** Slash names this host registered under a different name (e.g. `init` -> `memory-init`). */
  readonly commandNames?: Readonly<Partial<Record<string, string>>>
  exec?: GitExec
  now?(): number
}

/** `/<name>` as this host registered it. */
export function slashCommand(deps: Pick<MemoryCommandDeps, "commandNames">, name: string): string {
  return `/${deps.commandNames?.[name] ?? name}`
}

/** Notify (when a UI is present) and return the same text for headless consumers. */
export function respond(ctx: MemoryCommandContext, text: string, level: NotifyLevel = "info"): string {
  const safe = redactSecretLikeMaterial(text)
  ctx.ui?.notify(safe, level)
  return safe
}

export function sessionIdOf(ctx: MemoryCommandContext): string | undefined {
  return ctx.sessionManager?.getSessionId()
}

/** Bound identity required by most handlers; undefined yields an actionable error text. */
function identityFor(deps: MemoryCommandDeps, ctx: MemoryCommandContext): MemoryCommandIdentity | undefined {
  const sessionId = sessionIdOf(ctx)
  if (sessionId === undefined) return undefined
  return deps.contextForSession(sessionId)
}

/** `/memfs init` fallback: bound identity first, then the config-resolved identity. */
export function identityForInit(deps: MemoryCommandDeps, ctx: MemoryCommandContext): MemoryCommandIdentity | undefined {
  return identityFor(deps, ctx) ?? deps.resolveIdentity?.()
}

export function requireIdentity(
  deps: MemoryCommandDeps,
  ctx: MemoryCommandContext,
): MemoryCommandIdentity | string {
  const identity = identityFor(deps, ctx)
  if (identity !== undefined) return identity
  return "memory is not bound to this session; start a session with memory enabled and retry"
}

/** Interactive = dialog-capable UI (senpi hasUI); noninteractive handlers require --force. */
export function isInteractive(ctx: MemoryCommandContext): boolean {
  return ctx.hasUI === true && typeof ctx.ui?.confirm === "function"
}
