// V2 port of the Native `eval` tool (senpi-codemode): persistent JS/Python kernels, optional QuickJS
// sandbox cells, per-call abort. Registered `codemode: false` with the `eval` permission action, so a
// user's `eval` deny rule removes it the same way it does in Native.
//
// Who gets it, mirroring Native: root sessions only (Native task children run in-process with the
// parent's omo tools, which never include codemode's `eval`), and never the read-only roles (Native
// curated agents have tool allowlists without `eval`; V2 marks them by denying `bash`). codemode runs in a
// `node:worker_threads` Worker started on the first call (codemode-worker-client.ts), so its multi-second import never
// stalls OpenCode's main thread; until it has loaded the model sees a compact description, then the
// context hook swaps in codemode's own description and schema.

import type * as Plugin from "@opencode/plugin/promise/plugin"
import type { Registration } from "@opencode/plugin/promise/registration"
import type { Info, Result, ToolContext } from "@opencode/plugin/promise/tool"
import { createHash } from "node:crypto"
import { existsSync } from "node:fs"
import { homedir, tmpdir } from "node:os"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { AGENT_DEFINITIONS } from "../agents/definitions"
import type { OwnedEvalHostTool } from "./codemode-host-tools"
import type { ProcessEvents } from "./codemode-session-registry"
import { createCodemodeWorkerBackend } from "./codemode-worker-client"
import type { EvalBackend } from "./codemode-worker-protocol"
import { adaptEvalResult, progressText, toToolError } from "./native-eval-result"

export const NATIVE_EVAL_TOOL_NAME = "eval"
export const NATIVE_EVAL_PERMISSION = "eval"
const NATIVE_EVAL_SANDBOX_OPTION = "omo-native-eval-sandbox"

/** V2 roles registered read-only (they deny `bash`): an eval cell is a shell, so they never get one. */
export const EVAL_DENIED_AGENTS: ReadonlySet<string> = new Set(
  AGENT_DEFINITIONS.filter((definition) =>
    definition.restrictions.some((rule) => rule.action === "bash" && rule.resource === "*" && rule.effect === "deny"),
  ).map((definition) => definition.id),
)

/** Shown until the codemode package has loaded; then codemode's own description replaces it. */
export const NATIVE_EVAL_PLACEHOLDER_DESCRIPTION = [
  'Run code in a persistent kernel for this session (state survives between calls). language: "js" (Bun) or "py" (Python, when installed).',
  "Pass code and a one-line summary of what you are doing and why. The value of the last expression is returned; print() and display() emit output.",
  "With isolate: true (js only) the cell runs in a fresh QuickJS sandbox with no fs, net, process or timers.",
  'action: "list" lists detached cells; action "peek" or "stop" with cell_id reads or stops one. reset: true restarts that language\'s kernel.',
  "The first call in a server starts the runtime and can take a few seconds.",
].join(" ")

const NATIVE_EVAL_PLACEHOLDER_INPUT = {
  type: "object",
  properties: {
    language: { type: "string", enum: ["js", "py", "rb", "jl"], description: "Kernel language." },
    code: { type: "string", description: "Code to run." },
    summary: { type: "string", description: "REQUIRED for run. One line: what you are doing and why." },
    isolate: {
      type: "boolean",
      description: "js only. Fresh sandbox per call: no persistence, no fs/net/process/timers.",
    },
    timeout: { type: "number", minimum: 1, description: "Cell run budget in seconds." },
    on_timeout: { type: "string", enum: ["detach", "error"] },
    reset: { type: "boolean", description: "Reset this language kernel before running." },
    action: { type: "string", enum: ["run", "list", "peek", "stop"] },
    cell_id: { type: "string", description: "Eval cell id for peek or stop." },
  },
} as const

export type NativeEvalHost = Pick<Plugin.Context, "tool" | "session" | "event" | "location"> &
  Partial<Pick<Plugin.Context, "options">>

export interface NativeEvalOptions {
  /** Defaults to the codemode worker client; tests drive a fake. */
  readonly backend?: EvalBackend
  /** Plugin-owned tools a cell may call (`tools.X`); they run here, on the main thread, and receive the
   * calling eval call's own SDK context as `caller` (the owned `task` executor, eval-task-host-tool.ts). */
  readonly ownedTools?: readonly OwnedEvalHostTool[]
  readonly processEvents?: ProcessEvents
  readonly home?: string
  /** Directory holding the built agent-toolkit `sdk.js`; defaults to the copy staged next to this bundle. */
  readonly agentToolkitSdkRoot?: string
  /** The session's goal file (the Native goal store), exposed to cells as PI_GOAL_STORE_FILE like Native. */
  readonly goalStoreFile?: (sessionID: string) => string
  readonly createTimeoutMs?: number
  readonly disposeTimeoutMs?: number
}

/** Per-session spill directory, inside the project's `.omo` like Native task state; never `~/.omo`. */
export function evalStateDir(projectDirectory: string, sessionID: string, home: string = homedir()): string {
  const key = createHash("sha256").update(sessionID).digest("hex")
  if (resolve(projectDirectory) === resolve(home)) return join(tmpdir(), "omo-opencode-v2-eval", key)
  return join(projectDirectory, ".omo", "eval", "opencode-v2", key)
}

const AGENT_TOOLKIT_SDK_DIRECTORY = "agent-toolkit-sdk"

/** The build stages the ulw-loop agent-toolkit SDK next to the V2 chunks (script/build-agent-toolkit-sdk.ts). */
function locateAgentToolkitSdkRoot(directory: string = dirname(fileURLToPath(import.meta.url))): string | undefined {
  const root = join(directory, AGENT_TOOLKIT_SDK_DIRECTORY)
  return existsSync(join(root, "sdk.js")) ? root : undefined
}

/**
 * The kernel environment of one eval session, as Native's codemode sets it for its own sessions: the host's
 * session id and directory bind the agent-toolkit SDK to the CALLING session, never to an id a cell supplies.
 */
export function evalSessionEnvironment(input: {
  readonly directory: string
  readonly sessionID: string
  readonly agentToolkitSdkRoot?: string | undefined
  readonly goalStoreFile?: string | undefined
}): Readonly<Record<string, string>> {
  return {
    PI_SESSION_ID: input.sessionID,
    PI_SESSION_CWD: input.directory,
    ...(input.agentToolkitSdkRoot !== undefined && { OMO_AGENT_TOOLKIT_SDK_ROOT: input.agentToolkitSdkRoot }),
    ...(input.goalStoreFile !== undefined && { PI_GOAL_STORE_FILE: input.goalStoreFile }),
  }
}

/** A cell's host-tool call names its eval call; this resolves it to that call's own SDK context, only
 * while the call runs and only in the same session. A detached cell's call gets no caller. */
export function bindEvalCallers(
  tools: readonly OwnedEvalHostTool[],
  running: ReadonlyMap<string, ToolContext>,
): OwnedEvalHostTool[] {
  return tools.map((tool) => ({
    name: tool.name,
    description: tool.description,
    parameters: tool.parameters,
    execute(params, call) {
      const context = call.toolCallId === undefined ? undefined : running.get(call.toolCallId)
      const caller = context && context.sessionID === call.sessionID ? context : undefined
      return tool.execute(params, { ...call, ...(caller && { caller }) })
    },
  }))
}

function abortable<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(signal.reason ?? Error("eval aborted"))
  return new Promise<T>((resolvePromise, reject) => {
    const onAbort = () => reject(signal.reason ?? Error("eval aborted"))
    signal.addEventListener("abort", onAbort, { once: true })
    work.then(
      (value) => {
        signal.removeEventListener("abort", onAbort)
        resolvePromise(value)
      },
      (error: unknown) => {
        signal.removeEventListener("abort", onAbort)
        reject(error)
      },
    )
  })
}

export async function registerNativeEval(
  host: NativeEvalHost,
  options: NativeEvalOptions = {},
): Promise<() => Promise<void>> {
  const directory = host.location.directory
  const sandbox = host.options?.[NATIVE_EVAL_SANDBOX_OPTION] !== false
  const stateDir = (sessionID: string) => evalStateDir(directory, sessionID, options.home)
  const agentToolkitSdkRoot = options.agentToolkitSdkRoot ?? locateAgentToolkitSdkRoot()
  const sessionEnv = (sessionID: string) =>
    evalSessionEnvironment({
      directory,
      sessionID,
      agentToolkitSdkRoot,
      goalStoreFile: options.goalStoreFile?.(sessionID),
    })
  const stop = new AbortController()
  const roots = new Map<string, Promise<boolean>>()
  const registrations: Registration[] = []
  let hostID: string | undefined
  let closed = false
  let pump: Promise<void> | undefined
  /** Running eval calls by call id: a cell's host-tool call names its eval call, never a context. */
  const running = new Map<string, ToolContext>()
  const ownedTools = bindEvalCallers(options.ownedTools ?? [], running)

  const backend =
    options.backend ??
    createCodemodeWorkerBackend({
      cwd: directory,
      sandbox,
      ownedTools,
      stateDir,
      sessionEnv,
      ...(options.createTimeoutMs !== undefined && { createTimeoutMs: options.createTimeoutMs }),
      ...(options.disposeTimeoutMs !== undefined && { disposeTimeoutMs: options.disposeTimeoutMs }),
      ...(options.processEvents && { processEvents: options.processEvents }),
    })

  /** Root session in this plugin's directory; cached, since a session's parent never changes. */
  function isRoot(sessionID: string, signal?: AbortSignal): Promise<boolean> {
    let known = roots.get(sessionID)
    if (!known) {
      known = host.session
        .get({ sessionID }, signal ? { signal } : undefined)
        .then(
          (info) =>
            (info.parentID === undefined || info.parentID === null) &&
            resolve(info.location.directory) === resolve(directory),
        )
      roots.set(sessionID, known)
      known.catch(() => {
        if (roots.get(sessionID) === known) roots.delete(sessionID)
      })
    }
    return known
  }

  async function execute(input: unknown, context: ToolContext): Promise<Result> {
    try {
      if (closed) throw Error("eval is shutting down")
      if (EVAL_DENIED_AGENTS.has(context.agent))
        throw Error(
          `eval is not available to the ${context.agent} agent: read-only roles cannot run code, as in Native.`,
        )
      if (!(await abortable(isRoot(context.sessionID, context.signal), context.signal))) {
        throw Error("eval is available only in root sessions of this project; Native task children do not get eval.")
      }
      await abortable(backend.load(), context.signal)
      const session = await abortable(backend.acquire(context.sessionID, context.signal), context.signal)
      const onUpdate = (update: unknown) => {
        const text = progressText(update)
        if (text !== undefined) void context.progress({ eval: { output: text } }).catch(() => {})
      }
      // The worker serializes calls per session (Native runs `eval` sequentially) and prepares the arguments.
      running.set(String(context.id), context)
      try {
        return adaptEvalResult(await session.run(String(context.id), input, context.signal, onUpdate))
      } finally {
        if (running.get(String(context.id)) === context) running.delete(String(context.id))
      }
    } catch (error) {
      throw toToolError(error)
    }
  }

  let disposal: Promise<void> | undefined
  const cleanup = () => {
    disposal ??= (async () => {
      closed = true
      stop.abort(Error("eval component disposed"))
      const results = await Promise.allSettled([
        ...registrations.reverse().map((registration) => registration.dispose()),
        backend.dispose(),
      ])
      if (pump) await pump
      roots.clear()
      running.clear()
      const failures = results.flatMap((result) => (result.status === "rejected" ? [result.reason] : []))
      if (failures.length) throw new AggregateError(failures, "eval component cleanup incomplete")
    })()
    return disposal
  }

  try {
    const tool: Info = {
      name: NATIVE_EVAL_TOOL_NAME,
      description: NATIVE_EVAL_PLACEHOLDER_DESCRIPTION,
      input: NATIVE_EVAL_PLACEHOLDER_INPUT as unknown as Info["input"],
      options: { codemode: false, permission: NATIVE_EVAL_PERMISSION },
      execute,
    }
    let collided = false
    registrations.push(
      await host.tool.transform((editor) => {
        // Never shadow another plugin's `eval`: the model would get two tools with one name.
        collided = editor.list().some((entry) => entry.name === NATIVE_EVAL_TOOL_NAME && entry.execute !== execute)
        if (!collided) editor.add(tool)
      }),
    )
    if (collided) {
      console.warn("[oh-my-openagent/v2] another `eval` tool is registered; the Native eval port stays off")
      return cleanup
    }
    const listed = (await host.tool.list()).filter(
      (entry) => entry.name === NATIVE_EVAL_TOOL_NAME && entry.options?.namespace === undefined,
    )
    if (listed.length !== 1 || !listed[0]) throw Error("eval registration is absent or ambiguous")
    hostID = listed[0].id
    registrations.push(
      await host.session.hook("context", async (context) => {
        const id = hostID
        if (closed || !id || !context.tools[id]) return
        if (EVAL_DENIED_AGENTS.has(context.agent) || !(await isRoot(context.sessionID).catch(() => false))) {
          delete context.tools[id]
          return
        }
        const definition = backend.definition()
        if (definition)
          context.tools[id] = {
            description: definition.description,
            input: definition.parameters as (typeof context.tools)[string]["input"],
          }
      }),
    )
    pump = (async () => {
      try {
        for await (const event of host.event.subscribe({ types: ["session.deleted"], signal: stop.signal })) {
          if (closed) break
          roots.delete(event.data.sessionID)
          await backend
            .release(event.data.sessionID)
            .catch((error) => console.warn("[oh-my-openagent/v2] eval session cleanup failed", error))
        }
      } catch (error) {
        if (!stop.signal.aborted) console.warn("[oh-my-openagent/v2] eval session event stream failed", error)
      }
    })()
  } catch (error) {
    try {
      await cleanup()
    } catch (cleanupError) {
      throw new AggregateError([error, cleanupError], "eval registration and rollback failed")
    }
    throw error
  }
  return cleanup
}
