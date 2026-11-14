// Per-session senpi-codemode runtimes for the V2 `eval` tool: one kernel manager, handle registry and
// detached-cell manager per OpenCode session, created on that session's first eval call. Everything here
// runs inside the codemode worker (codemode-worker-runtime.ts), never on OpenCode's main thread: the S9c
// spike measured a 15-30 s server freeze when codemode's module graph was imported on the main thread.

import { mkdirSync } from "node:fs"
import { join } from "node:path"
import type { CodemodeModules } from "./codemode-loader"
import { createOwnedHostToolBridge, type OwnedEvalHostTool } from "./codemode-host-tools"
import type { KernelPreludeContribution } from "./codemode-worker-protocol"

/** The senpi `ToolDefinition` slice V2 drives. */
export interface EvalToolDefinition {
  readonly name: string
  readonly description: string
  readonly parameters: unknown
  prepareArguments?(args: unknown): unknown
  execute(
    toolCallId: string,
    params: unknown,
    signal: AbortSignal | undefined,
    onUpdate: ((update: unknown) => void) | undefined,
    ctx: unknown,
  ): Promise<unknown>
}

export interface EvalSessionRuntime {
  readonly tool: EvalToolDefinition
  /** Loopback endpoint of the codemode host bridge, for QA. */
  bridgeEndpoint(): { readonly port: number } | undefined
  /** Serializes calls: Native runs `eval` with `executionMode: "sequential"`. */
  exclusive<T>(signal: AbortSignal, work: () => Promise<T>): Promise<T>
  /** Fails saved handles closed, disposes detached cells, then kills the kernel trees. */
  dispose(): Promise<void>
  /** Process-exit path: start every teardown at once without awaiting anything. */
  abandon(): void
}

export interface PreludeOptions {
  /** Read at the start of every cell, as Native reads the active tools' preludes. */
  readonly kernelPreludes?: () => readonly KernelPreludeContribution[]
  readonly promptKernelPreludes?: readonly KernelPreludeContribution[]
}

export interface EvalRuntimeInput extends PreludeOptions {
  readonly sessionID: string
  readonly cwd: string
  /** Per-session directory for spilled artifacts and the synthetic session-file path. */
  readonly stateDir: string
  readonly sandbox: boolean
  readonly ownedTools: readonly OwnedEvalHostTool[]
  readonly signal: AbortSignal
  readonly sessionEnv?: Readonly<Record<string, string>>
}

type Construct = new (...args: unknown[]) => Record<string, unknown>
type Call = (...args: unknown[]) => unknown

function method(target: Record<string, unknown>, name: string): Call {
  const value = target[name]
  if (typeof value !== "function") throw Error(`senpi-codemode object has no ${name}()`)
  return (...args: unknown[]) => (value as Call).apply(target, args)
}

/** Settings built here, never read from `~/.senpi/agent/codemode.json`: Native defaults plus the
 * QuickJS sandbox (`isolate: true`) when enabled. */
function buildCodemodeSettings(modules: CodemodeModules, sandbox: boolean): Record<string, unknown> {
  const base = { ...modules.defaultCodemodeSettings, sandbox: { enabled: sandbox } }
  return { ...base, languages: (modules.resolveEnabledLanguages as Call)(base) }
}

function refuseCompletion(): Promise<never> {
  return Promise.reject(new Error("llm() completions are not available in OpenCode eval cells"))
}

/** Description and schema of `eval` for this machine, built without starting any kernel. */
export async function buildEvalDefinition(
  modules: CodemodeModules,
  sandbox: boolean,
  promptKernelPreludes: readonly KernelPreludeContribution[] = [],
): Promise<{ readonly description: string; readonly parameters: unknown }> {
  const settings = buildCodemodeSettings(modules, sandbox)
  const availability = await (modules.getInterpreterAvailability as Call)(
    settings,
    (modules.createInterpreterDetector as Call)(),
  )
  const enabledLanguages = (modules.enabledLanguagesFrom as Call)(settings, availability)
  const tool = (modules.createEvalTool as Call)({
    ...evalToolOptions(modules, settings, enabledLanguages, availability, { promptKernelPreludes }),
    kernelManager: new (modules.SessionManagerProxy as unknown as Construct)(),
    executeTool: Object.assign(() => Promise.reject(Error("no session")), { isToolAvailable: () => false }),
    listTools: () => [],
  }) as EvalToolDefinition
  return { description: tool.description, parameters: tool.parameters }
}

function evalToolOptions(
  modules: CodemodeModules,
  settings: Record<string, unknown>,
  enabledLanguages: unknown,
  availability: unknown,
  preludes: PreludeOptions = {},
) {
  return {
    ...(preludes.kernelPreludes && { kernelPreludes: preludes.kernelPreludes }),
    ...(preludes.promptKernelPreludes?.length && { promptKernelPreludes: preludes.promptKernelPreludes }),
    enabledLanguages,
    cellTimeoutSeconds: settings.cellTimeoutSeconds,
    foregroundWindowSeconds: (modules.resolveForegroundWindowSeconds as Call)(settings),
    runBudgetSeconds: (modules.resolveRunBudgetSeconds as Call)(settings),
    hardLimitSeconds: (modules.resolveHardLimitSeconds as Call)(settings),
    settings,
    // Cells cannot spawn `task` children until S9d routes the owned task executor; no monitor tool.
    spawns: false,
    monitor: false,
    runtimes: (modules.runtimesFromAvailability as Call)(availability, (modules.jsRuntimeInfo as Call)()),
  }
}

export async function createEvalSessionRuntime(
  modules: CodemodeModules,
  input: EvalRuntimeInput,
): Promise<EvalSessionRuntime> {
  const artifactsDir = join(input.stateDir, "artifacts")
  mkdirSync(artifactsDir, { recursive: true })
  const settings = buildCodemodeSettings(modules, input.sandbox)
  const availability = await (modules.getInterpreterAvailability as Call)(
    settings,
    (modules.createInterpreterDetector as Call)(),
  )
  input.signal.throwIfAborted()
  const enabledLanguages = (modules.enabledLanguagesFrom as Call)(settings, availability)
  const bridge = createOwnedHostToolBridge({
    sessionID: input.sessionID,
    tools: input.ownedTools,
    readKernelTools: () => modules.kernelToolsStorage.getStore(),
  })
  const raw = (await (modules.createCodemodeSessionManager as Call)({
    sessionId: input.sessionID,
    ownerSessionId: input.sessionID,
    cwd: input.cwd,
    ...(input.sessionEnv && { sessionEnv: input.sessionEnv }),
    settings,
    availability,
    artifactsDir,
    killGuard: false,
    executeTool: bridge.executeTool,
    listTools: bridge.listTools,
    complete: refuseCompletion,
  })) as Record<string, unknown>
  const manager = new (modules.SessionManagerProxy as unknown as Construct)()
  let handles: Record<string, unknown> | undefined
  let cells: Record<string, unknown> | undefined
  let replaced = false
  try {
    input.signal.throwIfAborted()
    replaced = (await method(manager, "replace")(method(manager, "beginReplacement")(), raw)) === true
    if (!replaced) throw Error("codemode session manager replacement was refused")
    handles = new (modules.HandleRegistry as unknown as Construct)({ ownerSessionId: input.sessionID })
    // No wake channel: a detached cell is read back with `action: "peek"`, never pushed into the session.
    cells = new (modules.EvalDetachedCellManager as unknown as Construct)({
      artifactsDir,
      maxDetachedCells: (modules.resolveMaxDetachedCells as Call)(settings),
      notifier: { notify() {}, reset() {} },
    })
  } catch (error) {
    // Before a successful replace the proxy does not own the raw manager, so its kernels go directly.
    await method(replaced ? manager : raw, "dispose")()
    throw error
  }
  const tool = (modules.createEvalTool as Call)({
    ...evalToolOptions(modules, settings, enabledLanguages, availability, input),
    kernelManager: manager,
    executeTool: bridge.executeTool,
    listTools: bridge.listTools,
    artifactsDir,
    cellManager: cells,
    handles,
    executionTracker: manager,
  }) as EvalToolDefinition
  const ownedHandles = handles,
    ownedCells = cells
  let queue: Promise<unknown> = Promise.resolve()
  let disposal: Promise<void> | undefined
  const teardown = async () => {
    const errors: unknown[] = []
    try {
      method(ownedHandles, "dispose")()
    } catch (error) {
      errors.push(error)
    }
    try {
      await method(ownedCells, "dispose")()
    } catch (error) {
      errors.push(error)
    }
    try {
      await method(manager, "dispose")()
    } catch (error) {
      errors.push(error)
    }
    if (errors.length) throw new AggregateError(errors, "eval session runtime cleanup incomplete")
  }
  return {
    tool,
    bridgeEndpoint() {
      const endpoint = typeof raw.bridgeEndpoint === "function" ? (raw.bridgeEndpoint as Call).call(raw) : undefined
      return endpoint && typeof endpoint === "object" && typeof (endpoint as { port?: unknown }).port === "number"
        ? { port: (endpoint as { port: number }).port }
        : undefined
    },
    exclusive(signal, work) {
      const turn = queue.then(() => {
        signal.throwIfAborted()
        if (disposal) throw Error("eval session runtime is closed")
        return work()
      })
      queue = turn.catch(() => {})
      return turn
    },
    dispose() {
      disposal ??= teardown()
      return disposal
    },
    abandon() {
      if (disposal) return
      // Kernel trees first: their synchronous kill paths must start before the process is gone.
      disposal = Promise.allSettled([
        method(manager, "dispose")(),
        Promise.resolve().then(() => method(ownedHandles, "dispose")()),
        method(ownedCells, "dispose")(),
      ]).then(() => {})
    },
  }
}
