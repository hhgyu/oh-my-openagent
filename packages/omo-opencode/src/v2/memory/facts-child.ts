// Hosting of the owned `omo-facts` extractor child. Each run gets its own memory child port (a durable
// custody journal at `<identity facts>/children.sqlite`, parented to the bound root session that
// triggered the launch) and stages the hidden facts agent with deny-all-but-`record_fact` permissions,
// the run's model, and the payload prompt as its first admitted input. Settlement is bounded by the
// run deadline; the port is always closed (interrupt, wait, remove) before the parent finalizes.
// Stranded children of a dead host are reclaimed before stranded runs settle (`facts-child-reclaim.ts`).
// Scoping mirrors the Kibitzer tools: `record_fact` answers only for an issued child whose lease is
// current, the child's model request is narrowed to that one tool, and every other session's request
// has it removed.

import { join } from "node:path"
import { Model } from "@opencode/plugin"
import type { Context } from "@opencode/plugin/promise/plugin"
import type { SessionContext } from "@opencode/plugin/promise/session"
import type { Info } from "@opencode/plugin/promise/tool"
import { createSessionScopes, type SessionLease } from "../host/session-state"
import type { SessionBackendApi } from "../host/session-backend"
import { hasJoinedSessionCancellation } from "../host/session-cancellation"
import type { BoundMemorySession } from "./binding"
import { FACTS_AGENT_ID, FACTS_PERMISSIONS } from "./facts-agent"
import { FACTS_BACKEND_ID, reclaimStrandedFactsChildren } from "./facts-child-reclaim"
import { createFactsRecorder, createFactsRecordTool, FACTS_RECORD_TOOL_NAME, type FactsRecorder } from "./facts-record-tool"
import type { FactsChildLaunch, FactsChildResult } from "./facts-runner"
import {
  createMemoryChildPort, settleWithin, type IssuedMemoryChild, type MemoryChildPermissions, type MemoryChildPort, type MemoryChildTimers,
} from "./memory-child-port"

const FACTS_CHILD_JOURNAL_FILENAME = "children.sqlite"

export interface FactsPortRequest {
  readonly bound: BoundMemorySession
  readonly parentSessionId: string
  readonly journalPath: string
  readonly agent: string
  readonly permissions: MemoryChildPermissions
  readonly toolNames: readonly string[]
  readonly scopes: ReturnType<typeof createSessionScopes>
  onIssued(child: IssuedMemoryChild): void
  onRetired(sessionID: string): void
}

interface FactsChildHost {
  readonly app?: Context["app"]
  readonly session: object
}

interface FactsChildHostingDeps {
  readonly host: FactsChildHost
  readonly createPort?: (request: FactsPortRequest) => MemoryChildPort
  readonly timers?: MemoryChildTimers
  readonly warn: (message: string, details?: Record<string, unknown>) => void
}

function isBackendSession(session: object): session is SessionBackendApi {
  return hasJoinedSessionCancellation(session)
}

export function createFactsChildHosting(deps: FactsChildHostingDeps) {
  const scopes = createSessionScopes()
  const children = new Map<string, { readonly recorder: FactsRecorder; readonly lease: SessionLease }>()
  let closed = false

  function resolve(sessionID: string): FactsRecorder | undefined {
    const entry = children.get(sessionID)
    if (entry === undefined || closed) return undefined
    try {
      scopes.assert(entry.lease)
    } catch {
      return undefined
    }
    return entry.recorder
  }

  function productionPort(request: FactsPortRequest): MemoryChildPort {
    const app = deps.host.app
    const session = deps.host.session
    if (app === undefined || !isBackendSession(session)) throw new Error("Facts child port requires the host app identity and the joined Effect session transport")
    return createMemoryChildPort({
      host: { app, session }, directory: request.bound.directory, parentSessionId: request.parentSessionId, journalPath: request.journalPath,
      backendID: FACTS_BACKEND_ID, prefix: "facts", label: "Facts", agent: request.agent, permissions: request.permissions,
      toolNames: request.toolNames, scopes: request.scopes, onIssued: request.onIssued, onRetired: request.onRetired,
    })
  }

  async function launch(bound: BoundMemorySession, input: FactsChildLaunch): Promise<FactsChildResult> {
    if (closed) return { status: "cancelled" }
    const recorder = createFactsRecorder({ extractionPath: input.extractionPath, exchanges: input.exchanges })
    const request: FactsPortRequest = {
      bound, parentSessionId: input.parentSessionId, journalPath: join(bound.paths.facts, FACTS_CHILD_JOURNAL_FILENAME),
      agent: FACTS_AGENT_ID, permissions: FACTS_PERMISSIONS.map(rule => ({ ...rule })), toolNames: [FACTS_RECORD_TOOL_NAME], scopes,
      onIssued: child => { children.set(child.sessionID, { recorder, lease: child.lease }) },
      onRetired: sessionID => { children.delete(sessionID) },
    }
    const model = Model.Ref.parse(input.model)
    const port = deps.createPort?.(request) ?? productionPort(request)
    let stopped = false
    input.onCancel(() => {
      stopped = true
      void port.close().catch((error: unknown) => { deps.warn("facts child cancel incomplete", { runId: input.runId, error: String(error) }) })
    })
    try {
      const child = await port.start({ generation: 1, prompt: input.prompt, model })
      const settled = await settleWithin(child, input.deadlineMs, deps.timers)
      if (settled === "deadline") return { status: "deadline", detail: `facts child did not settle within ${input.deadlineMs} ms` }
      if (settled.status === "cancelled" || stopped) return { status: "cancelled" }
      if (settled.status === "error") return { status: "failed", detail: settled.message ?? "facts child turn failed" }
      return { status: "completed" }
    } finally {
      recorder.deactivate()
      await port.close().catch((error: unknown) => { deps.warn("facts child cleanup incomplete", { runId: input.runId, error: String(error) }) })
    }
  }

  /** Takes over and removes hidden facts children a dead host left in this identity's custody journal. */
  async function reclaim(bound: BoundMemorySession): Promise<void> {
    const app = deps.host.app
    const session = deps.host.session
    if (closed || app === undefined || !isBackendSession(session)) return
    await reclaimStrandedFactsChildren({ host: { app, session }, journalPath: join(bound.paths.facts, FACTS_CHILD_JOURNAL_FILENAME), warn: deps.warn })
  }

  return {
    launch,
    reclaim,
    isFactsSession: (sessionID: string): boolean => children.has(sessionID),
    tool: (): Info => createFactsRecordTool(resolve),
    /** True when the request belongs to a facts child (narrowed to `record_fact`; nothing else applies). */
    onContext(value: Pick<SessionContext, "sessionID" | "tools">): boolean {
      if (!children.has(value.sessionID)) {
        Reflect.deleteProperty(value.tools, FACTS_RECORD_TOOL_NAME)
        return false
      }
      for (const name of Object.keys(value.tools)) if (name !== FACTS_RECORD_TOOL_NAME) Reflect.deleteProperty(value.tools, name)
      return true
    },
    close(): void {
      closed = true
      children.clear()
      scopes.dispose()
    },
  }
}

export type FactsChildHosting = ReturnType<typeof createFactsChildHosting>
