// The goal trio Native ships is the senpi engine's builtin goal extension (`core/extensions/builtin/goal`). V2 runs that
// same code: the store, its lock and file format, the tool descriptions, schemas and validation all come from the
// INSTALLED engine, imported by computed file URL (the package exports no subpath for them) and pinned to the version
// these structural types were checked against, as codemode-loader.ts does for codemode.
import { join } from "node:path"
import { pathToFileURL } from "node:url"
import { packageDirectory, readInstalledVersion } from "../tools/codemode-loader"

const SENPI_PACKAGE = "@code-yeongyu/senpi"
const GOAL_ENGINE_VERSION = "2026.11.12"
const GOAL_EXTENSION_DIR = join("dist", "core", "extensions", "builtin", "goal")

export interface GoalStoreRef {
  readonly baseDir: string
  readonly threadId: string
}
export interface EngineGoal {
  readonly id: string
  readonly threadId: string
  readonly objective: string
  readonly status: string
  readonly continuationStoppedAt?: number
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
  }
  registerGoalTools(pi: { registerTool(tool: EngineGoalTool): void }, deps: EngineGoalToolDeps): void
  openTodoCompletionError(openTasks: readonly string[]): string
}

function resolveEngineRoot(from: string = import.meta.dir): string {
  return packageDirectory(Bun.resolveSync(SENPI_PACKAGE, from), SENPI_PACKAGE)
}

function member<T>(module: Record<string, unknown>, name: string): T {
  const value = module[name]
  if (typeof value !== "function") throw Error(`${SENPI_PACKAGE} goal extension export ${name} is missing`)
  return value as T
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
    const [store, tools, gate] = await Promise.all([
      load("store.js"),
      load("tool-registration.js"),
      load("todo-gate.js"),
    ])
    return {
      store: {
        goalFilePath: member<GoalEngine["store"]["goalFilePath"]>(store, "goalFilePath"),
        readGoal: member<GoalEngine["store"]["readGoal"]>(store, "readGoal"),
        accountGoalUsage: member<GoalEngine["store"]["accountGoalUsage"]>(store, "accountGoalUsage"),
      },
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
