// The goal trio Native ships is the senpi engine's builtin goal extension (`core/extensions/builtin/goal`). V2 runs that
// same code: the store, its lock and file format, the tool descriptions, schemas and validation all come from the
// INSTALLED engine, imported by computed file URL (the package exports no subpath for them) and pinned to the version
// these structural types were checked against, as codemode-loader.ts does for codemode.
import { join } from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"
import { packageDirectory, readInstalledVersion } from "../tools/codemode-loader"
import type { GoalContinuationEngine, GoalEngine } from "./engine-types"

const SENPI_PACKAGE = "@code-yeongyu/senpi"
const GOAL_ENGINE_VERSION = "2026.11.12"
const GOAL_EXTENSION_DIR = join("dist", "core", "extensions", "builtin", "goal")

export type * from "./engine-types"

function resolveEngineRoot(): string {
  return packageDirectory(fileURLToPath(import.meta.resolve(SENPI_PACKAGE)), SENPI_PACKAGE)
}

function member<T>(module: Record<string, unknown>, name: string): T {
  const value = module[name]
  if (typeof value !== "function") throw Error(`${SENPI_PACKAGE} goal extension export ${name} is missing`)
  return value as T
}

function constant<T extends number | string>(module: Record<string, unknown>, name: string, type: string): T {
  const value = module[name]
  if (typeof value !== type) throw Error(`${SENPI_PACKAGE} goal extension export ${name} is missing`)
  return value as T
}

function continuationEngine(module: Record<string, unknown>): GoalContinuationEngine {
  const fn = <K extends keyof GoalContinuationEngine>(name: K) => member<GoalContinuationEngine[K]>(module, name)
  return {
    GOAL_USER_GRACE_DELAY_MS: constant(module, "GOAL_USER_GRACE_DELAY_MS", "number"),
    GOAL_TOOL_EFFECT_WINDOW: constant(module, "GOAL_TOOL_EFFECT_WINDOW", "number"),
    evaluateGoalContinuation: fn("evaluateGoalContinuation"),
    buildGoalContinuationSignature: fn("buildGoalContinuationSignature"),
    hashAssistantText: fn("hashAssistantText"),
    normalizeAssistantText: fn("normalizeAssistantText"),
    hasGoalContinuationProgress: fn("hasGoalContinuationProgress"),
    hasGoalTodoProgress: fn("hasGoalTodoProgress"),
    toolEffectFingerprint: fn("toolEffectFingerprint"),
    continuationTurnUsedTools: fn("continuationTurnUsedTools"),
  }
}

// lifecycle-helpers.js `blockedReasonForContinuationGuard` is module-private; the reasons are the engine's own.
function blockedReasons(recovery: Record<string, unknown>): GoalEngine["recovery"]["blockedReason"] {
  const reason = (name: string) => constant<string>(recovery, name, "string")
  return {
    cap: reason("CONTINUATION_CAP_BLOCKED_REASON"),
    "no-progress": reason("NO_PROGRESS_BLOCKED_REASON"),
    repetition: reason("REPETITION_BLOCKED_REASON"),
    "length-exhausted": reason("LENGTH_EXHAUSTED_BLOCKED_REASON"),
    "context-overflow": reason("CONTEXT_OVERFLOW_BLOCKED_REASON"),
    stale: undefined,
  }
}

let loading: Promise<GoalEngine> | undefined

export function loadGoalEngine(resolveRoot: () => string = resolveEngineRoot): Promise<GoalEngine> {
  if (loading) return loading
  const promise = (async (): Promise<GoalEngine> => {
    const root = resolveRoot()
    const version = readInstalledVersion(root)
    if (version !== GOAL_ENGINE_VERSION)
      throw Error(`${SENPI_PACKAGE} ${version} is installed; the V2 goal tools need ${GOAL_ENGINE_VERSION}`)
    const load = (file: string) =>
      import(pathToFileURL(join(root, GOAL_EXTENSION_DIR, file)).href) as Promise<Record<string, unknown>>
    const [store, tools, gate, continuation, prompt, recovery, cacheWarm, ui] = await Promise.all([
      load("store.js"),
      load("tool-registration.js"),
      load("todo-gate.js"),
      load("continuation.js"),
      load("prompt.js"),
      load("continuation-recovery.js"),
      load("cache-warm.js"),
      load("ui.js"),
    ])
    const storeFn = <K extends keyof GoalEngine["store"]>(name: K) => member<GoalEngine["store"][K]>(store, name)
    const promptFn = <K extends keyof GoalEngine["prompt"]>(name: K) => member<GoalEngine["prompt"][K]>(prompt, name)
    return {
      store: {
        goalFilePath: storeFn("goalFilePath"),
        readGoal: storeFn("readGoal"),
        accountGoalUsage: storeFn("accountGoalUsage"),
        updateGoal: storeFn("updateGoal"),
        recordContinuationDelivered: storeFn("recordContinuationDelivered"),
        resetContinuationStreak: storeFn("resetContinuationStreak"),
        recordGoalContinuationStopped: storeFn("recordGoalContinuationStopped"),
      },
      continuation: continuationEngine(continuation),
      prompt: {
        buildContinuationPrompt: promptFn("buildContinuationPrompt"),
        buildTruncationRecoveryPrompt: promptFn("buildTruncationRecoveryPrompt"),
        buildGoalStallNotice: promptFn("buildGoalStallNotice"),
      },
      recovery: {
        blockedReason: blockedReasons(recovery),
        isMechanicalContinuationBlock: member<GoalEngine["recovery"]["isMechanicalContinuationBlock"]>(
          recovery,
          "isMechanicalContinuationBlock",
        ),
      },
      backstopDelayMs: member<(seconds: number | undefined) => number>(
        cacheWarm,
        "resolveGoalMonitorContinuationDelayMs",
      )(undefined),
      ui: { goalStatusText: member<GoalEngine["ui"]["goalStatusText"]>(ui, "goalStatusText") },
      registerGoalTools: member<GoalEngine["registerGoalTools"]>(tools, "registerGoalTools"),
      openTodoCompletionError: member<GoalEngine["openTodoCompletionError"]>(gate, "openTodoCompletionError"),
    }
  })().catch((error: unknown) => {
    loading = undefined
    throw error
  })
  loading = promise
  return promise
}
