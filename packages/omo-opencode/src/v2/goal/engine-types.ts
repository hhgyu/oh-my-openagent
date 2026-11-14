// Structural types of the senpi engine goal modules V2 loads (engine.ts), checked against the pinned version.
export interface GoalStoreRef {
  readonly baseDir: string
  readonly threadId: string
}
export interface EngineGoal {
  readonly id: string
  readonly threadId: string
  readonly objective: string
  readonly status: string
  readonly tokensUsed: number
  readonly timeUsedSeconds: number
  readonly consecutiveContinuations?: number
  readonly unattendedContinuations?: number
  readonly noProgressContinuations?: number
  readonly lastContinuationSignature?: string
  readonly continuationStoppedAt?: number
  readonly blockedReason?: string
}
/** The engine's message shapes its continuation guards read (`@earendil-works/pi-ai` assistant / tool result). */
export type EngineMessage =
  | {
      readonly role: "assistant"
      readonly stopReason?: string
      readonly content: readonly (
        | { readonly type: "text"; readonly text: string }
        | { readonly type: "toolCall"; readonly name: string; readonly arguments: unknown }
      )[]
    }
  | {
      readonly role: "toolResult"
      readonly toolName: string
      readonly isError: boolean
      readonly content: readonly { readonly type: "text"; readonly text: string }[]
    }
export type GoalContinuationPath = "immediate" | "userGrace" | "monitorDelayed" | "sessionStart"
export interface GoalContinuationInput {
  readonly isIdle: boolean
  readonly hasPendingMessages: boolean
  readonly path: GoalContinuationPath
  readonly lastStopReason: string | undefined
  readonly lastTurnWasMalformedToolUse: boolean
  readonly consecutiveContinuations: number
  readonly lastContinuationSignature: string | undefined
  readonly currentSignature: string
  readonly consecutiveLengthRecoveries: number
  readonly recentNormalizedOutputHashes: readonly string[]
  readonly toollessContinuationStreak: number
  readonly continuationPending: boolean
  readonly lastTurnStuckOnContextOverflow: boolean
}
export type GoalDenyReason =
  | "not-eligible"
  | "single-flight"
  | "stale"
  | "context-overflow"
  | "cap"
  | "repetition"
  | "length-exhausted"
  | "no-progress"
export type GoalContinuationVerdict =
  | { readonly kind: "continue"; readonly prompt: "full" | "minimal"; readonly stallNotice: boolean }
  | { readonly kind: "deny"; readonly reason: GoalDenyReason }
type StoppedReason = Exclude<GoalDenyReason, "not-eligible" | "single-flight">
export interface GoalContinuationEngine {
  readonly GOAL_USER_GRACE_DELAY_MS: number
  readonly GOAL_TOOL_EFFECT_WINDOW: number
  evaluateGoalContinuation(input: GoalContinuationInput & { readonly goal: EngineGoal | null }): GoalContinuationVerdict
  buildGoalContinuationSignature(goal: EngineGoal, openTodos: number, totalTodos: number, textHash: string): string
  hashAssistantText(text: string): string
  normalizeAssistantText(text: string): string
  hasGoalContinuationProgress(
    input: Pick<GoalContinuationInput, "lastContinuationSignature" | "currentSignature">,
  ): boolean
  hasGoalTodoProgress(input: Pick<GoalContinuationInput, "lastContinuationSignature" | "currentSignature">): boolean
  toolEffectFingerprint(messages: readonly EngineMessage[]): string | undefined
  continuationTurnUsedTools(messages: readonly EngineMessage[]): boolean
}
export interface GoalUsage {
  input: number
  output: number
  cacheRead: number
  cacheWrite: number
  totalTokens: number
}
export type GoalAccountingMode = "active" | "activeOrBlocked" | "activeOrComplete"
export interface EngineToolResult {
  readonly content: readonly { readonly type: string; readonly text?: string }[]
  readonly details?: unknown
}
export interface EngineToolContext {
  readonly ref: GoalStoreRef
  readonly sessionManager: { getBranch(): readonly unknown[] }
}
export interface EngineGoalTool {
  readonly name: string
  readonly description: string
  readonly parameters: unknown
  execute(
    toolCallId: string,
    params: unknown,
    signal: AbortSignal | undefined,
    onUpdate: undefined,
    ctx: EngineToolContext,
  ): Promise<EngineToolResult>
}
export interface EngineGoalToolDeps {
  goalStoreRef(ctx: EngineToolContext): GoalStoreRef
  beginAgentGoalAccounting(goal: EngineGoal): void
  refreshGoalUi(ctx: EngineToolContext, goal: EngineGoal | null): void
  accountCurrentAgentTurn(ctx: EngineToolContext, mode: GoalAccountingMode): Promise<EngineGoal | null>
  markGoalBlockedThisTurn(goal: EngineGoal): void
  markGoalCompletedThisTurn(goal: EngineGoal): void
}
/** The slice of senpi's command context the engine's `/goal` handler reads (`command-registration.js`). */
export interface EngineCommandContext {
  readonly ref: GoalStoreRef
  readonly hasUI: false
  readonly ui: { notify(message: string, level?: "info" | "warning" | "error"): void }
}
export interface EngineGoalCommand {
  readonly description: string
  handler(args: string, ctx: EngineCommandContext): Promise<void>
}
export interface EngineGoalCommandDeps {
  goalStoreRef(ctx: EngineCommandContext): GoalStoreRef
  accountCurrentAgentTurn(ctx: EngineCommandContext, mode: GoalAccountingMode): Promise<EngineGoal | null>
  beginAgentGoalAccounting(goal: EngineGoal): void
  stopAgentGoalAccounting(goalId: string): void
  clearAgentGoalAccounting(): void
  queueGoalContinuation(pi: unknown, ctx: EngineCommandContext, goal: EngineGoal): void
  refreshGoalUi(ctx: EngineCommandContext, goal: EngineGoal | null): void
}
export interface GoalEngine {
  readonly store: {
    goalFilePath(ref: GoalStoreRef): string
    readGoal(ref: GoalStoreRef): Promise<EngineGoal | null>
    accountGoalUsage(
      ref: GoalStoreRef,
      usage: GoalUsage,
      elapsedSeconds: number,
      mode: GoalAccountingMode,
      expectedGoalId?: string,
    ): Promise<EngineGoal | null>
    updateGoal(
      ref: GoalStoreRef,
      update: { readonly status?: string; readonly reason?: string },
      source?: "model" | "user",
    ): Promise<EngineGoal>
    recordContinuationDelivered(
      ref: GoalStoreRef,
      signature: string,
      expectedGoalId?: string,
      options?: { readonly countUnattended?: boolean; readonly countStreak?: boolean },
    ): Promise<EngineGoal | null>
    resetContinuationStreak(
      ref: GoalStoreRef,
      options?: { readonly progress?: boolean; readonly unattended?: boolean },
    ): Promise<EngineGoal | null>
    recordGoalContinuationStopped(
      ref: GoalStoreRef,
      expected: EngineGoal,
      at: number,
      blockedReason: string | undefined,
      detail: {
        readonly reason: StoppedReason
        readonly consecutiveContinuations: number
        readonly unattendedContinuations: number
        readonly noProgressContinuations: number
      },
    ): Promise<{ readonly goal: EngineGoal | null; readonly recorded: boolean }>
  }
  readonly continuation: GoalContinuationEngine
  readonly prompt: {
    buildContinuationPrompt(goal: EngineGoal, options?: { readonly modelId?: string }): string
    buildTruncationRecoveryPrompt(): string
    buildGoalStallNotice(streak: number, options: { readonly liveSources: readonly string[] }): string
  }
  readonly recovery: {
    readonly blockedReason: Readonly<Record<StoppedReason, string | undefined>>
    isMechanicalContinuationBlock(blockedReason: string | undefined): boolean
  }
  /** The engine's monitor backstop with no configured `promptCache.goalBackstopMaxSeconds`. */
  readonly backstopDelayMs: number
  readonly ui: { goalStatusText(goal: EngineGoal): string }
  registerGoalTools(pi: { registerTool(tool: EngineGoalTool): void }, deps: EngineGoalToolDeps): void
  registerGoalCommand(
    pi: { registerCommand(name: string, command: EngineGoalCommand): void },
    deps: EngineGoalCommandDeps,
  ): void
  openTodoCompletionError(openTasks: readonly string[]): string
}
