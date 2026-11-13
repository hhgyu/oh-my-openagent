// One computer-use runtime per OpenCode session, as Native has one per agent session: created on the session's first
// `/computer`, tool call or eval call, closed (engine session ended) at session deletion and plugin dispose.

import type * as Plugin from "@opencode/plugin/promise/plugin"
import { Error as ToolError, type ToolContext } from "@opencode/plugin/promise/tool"
import type { PermissionDeniedData } from "@oh-my-opencode/senpi-desktop-protocol"
import type { ChildFactory } from "@oh-my-opencode/senpi-desktop-service"
import {
  COMPUTER_PERMISSION,
  type ComputerHostContext,
  type ComputerSettings,
} from "@oh-my-opencode/senpi-desktop-tool/registration"
import type { ControlConfirmRequest } from "@oh-my-opencode/senpi-desktop-tool"
import { createHash } from "node:crypto"
import { mkdirSync } from "node:fs"
import { homedir, tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { type EngineLocatorOptions, installedEngineChild } from "./engine"
import type { ComputerSessionRuntime } from "./runtime"

/** Native's foreground-control confirm bound: 15 s before the default 120 s run budget. */
const CONTROL_CONFIRM_TIMEOUT_MS = 105_000
const CONTROL_PERMISSION_RESOURCE = "control"

export interface SessionRuntimesOptions {
  readonly settings: ComputerSettings
  readonly directory: string
  readonly session: Pick<Plugin.Context["session"], "get">
  readonly permission: Pick<Plugin.Context["permission"], "assert">
  readonly onPermissionRequired: (
    sessionID: string,
    permission: Pick<PermissionDeniedData, "permission" | "app">,
  ) => void
  readonly home?: string
  readonly engine?: EngineLocatorOptions
  readonly createChild?: (enginePath: string | undefined) => ChildFactory
  readonly loadRuntime?: () => Promise<typeof import("./runtime")>
}

/** Per-session audit and artifact directory, inside the project's `.omo` like eval state; never `~/.omo`. */
function computerStateDir(projectDirectory: string, sessionID: string, home: string = homedir()): string {
  const key = createHash("sha256").update(sessionID).digest("hex")
  if (resolve(projectDirectory) === resolve(home)) return join(tmpdir(), "omo-opencode-v2-computer", key)
  return join(projectDirectory, ".omo", "computer", "opencode-v2", key)
}

function settleWithin(work: Promise<boolean>, ms: number, signal: AbortSignal): Promise<boolean> {
  return new Promise((resolvePromise, reject) => {
    const done = (value: boolean) => {
      clearTimeout(timer)
      signal.removeEventListener("abort", onAbort)
      resolvePromise(value)
    }
    const onAbort = () => done(false)
    const timer = setTimeout(() => done(false), ms)
    signal.addEventListener("abort", onAbort, { once: true })
    work.then(done, (error: unknown) => {
      clearTimeout(timer)
      signal.removeEventListener("abort", onAbort)
      reject(error)
    })
  })
}

export function createSessionRuntimes(options: SessionRuntimesOptions) {
  const runtimes = new Map<string, Promise<ComputerSessionRuntime>>()
  const loaded = new Map<string, ComputerSessionRuntime>()
  const callers = new WeakMap<ComputerHostContext, ToolContext>()
  const loadRuntime = options.loadRuntime ?? (() => import("./runtime"))
  const createChild = options.createChild ?? ((enginePath) => installedEngineChild(enginePath, options.engine))

  /** The `desktop.control.acquire` human confirm, as an OpenCode permission request the user answers. */
  async function confirmControl(request: ControlConfirmRequest): Promise<boolean> {
    const caller = callers.get(request.context)
    if (caller === undefined || request.signal.aborted) return false
    const asked = options.permission
      .assert({
        sessionID: caller.sessionID,
        agent: caller.agent,
        action: COMPUTER_PERMISSION,
        resources: [CONTROL_PERMISSION_RESOURCE],
        save: [CONTROL_PERMISSION_RESOURCE],
        metadata: { reason: request.reason },
        source: { type: "tool", messageID: caller.messageID, id: caller.id },
      })
      .then(
        () => true,
        (error: unknown) => {
          if (error instanceof ToolError) return false
          throw error
        },
      )
    const budget = Math.min(CONTROL_CONFIRM_TIMEOUT_MS, request.budgetMs ?? Number.POSITIVE_INFINITY)
    return settleWithin(asked, budget, request.signal)
  }

  function runtime(sessionID: string): Promise<ComputerSessionRuntime> {
    let pending = runtimes.get(sessionID)
    if (pending === undefined) {
      pending = loadRuntime().then((module) => {
        const created = module.createComputerSessionRuntime({
          settings: options.settings,
          createChild: createChild(options.settings.enginePath),
          confirmControl,
          onPermissionRequired: (permission) => options.onPermissionRequired(sessionID, permission),
        })
        loaded.set(sessionID, created)
        return created
      })
      runtimes.set(sessionID, pending)
      pending.catch(() => {
        if (runtimes.get(sessionID) === pending) runtimes.delete(sessionID)
      })
    }
    return pending
  }

  async function context(sessionID: string, caller?: ToolContext): Promise<ComputerHostContext> {
    const info = await options.session.get({ sessionID })
    const stateDir = computerStateDir(options.directory, sessionID, options.home)
    mkdirSync(stateDir, { recursive: true })
    const value: ComputerHostContext = {
      cwd: options.directory,
      model: info.model === undefined ? undefined : { id: info.model.id, provider: info.model.providerID, api: "" },
      sessionManager: { getSessionId: () => sessionID, getSessionDir: () => stateDir },
      hasUI: true,
    }
    if (caller !== undefined) callers.set(value, caller)
    return value
  }

  async function close(sessionID: string): Promise<void> {
    const pending = runtimes.get(sessionID)
    runtimes.delete(sessionID)
    loaded.delete(sessionID)
    if (pending !== undefined) await (await pending).handle.close()
  }

  return {
    runtime,
    context,
    loaded: (sessionID: string) => loaded.get(sessionID),
    enabled: (sessionID: string) => loaded.get(sessionID)?.handle.enabled ?? options.settings.enabled,
    close,
    async closeAll(): Promise<void> {
      const results = await Promise.allSettled([...runtimes.keys()].map(close))
      const failures = results.flatMap((result) => (result.status === "rejected" ? [result.reason] : []))
      if (failures.length) throw new AggregateError(failures, "computer use session cleanup incomplete")
    },
  }
}

export type SessionRuntimes = ReturnType<typeof createSessionRuntimes>
