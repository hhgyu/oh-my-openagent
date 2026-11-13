// Hosting of the owned `omo-reflection` child (plan S7e). Each launch gets its own memory child port
// (a durable custody journal at `<identity runtime>/reflection/children.sqlite`, parented to the
// root session that triggered the run) and stages the hidden reflection agent with
// deny-all-but-the-four-reflection-tools permissions, the run's model, and the task prompt as its first
// admitted input. Settlement is bounded by the caller's deadline; the port is always closed
// (interrupt, wait, remove) before `launch` returns, so the parent finalizes a worktree no child
// can still write to. Finalization (validate, merge, cleanup, complete) and crash recovery are S7f:
// this module only reports how the child settled and which commits it made. A run is resolved from
// the calling session: only an issued child whose lease is current reaches its run scope; the
// child's model request is narrowed to the four tools, and every other request has them removed.

import { join } from "node:path"
import { Model } from "@opencode/plugin"
import type { Context } from "@opencode/plugin/promise/plugin"
import type { SessionContext, SessionRetry } from "@opencode/plugin/promise/session"
import type { Info } from "@opencode/plugin/promise/tool"
import type { ReflectionRequest } from "@oh-my-opencode/memory-core"
import { createSessionScopes, type SessionLease } from "../host/session-state"
import type { SessionBackendApi } from "../host/session-backend"
import { hasJoinedSessionCancellation } from "../host/session-cancellation"
import type { BoundMemorySession } from "./binding"
import {
  createMemoryChildPort,
  type IssuedMemoryChild,
  type MemoryChildPermissions,
  type MemoryChildPort,
  type MemoryChildTimers,
  type MemoryChildTurnReport,
} from "./memory-child-port"
import { DREAM_AGENT_ID, REFLECTION_AGENT_ID, REFLECTION_PERMISSIONS } from "./reflection-agent"
import { buildReflectionTaskPrompt } from "./reflection-persona"
import { createReflectionRunScope, type ReflectionRunScope } from "./reflection-run-scope"
import { createReflectionTools, REFLECTION_TOOL_NAMES } from "./reflection-tools"
import type { ReflectionModelCandidate } from "./reflection-model-ladder"
import { reflectionAttempt, retryableReflectionModelFailure } from "./reflection-model-retry"

/** Backend identity of every reflection child locator; S7f's reclaim lists rows under it. */
export const REFLECTION_BACKEND_ID = "omo-reflection-opencode"
export const REFLECTION_CHILD_PREFIX = "reflection"
const REFLECTION_CHILD_JOURNAL_FILENAME = "children.sqlite"

/** The custody journal reflection children of one identity are staged under. */
export function reflectionChildJournalPath(bound: Pick<BoundMemorySession, "paths">): string {
  return join(bound.paths.reflection, REFLECTION_CHILD_JOURNAL_FILENAME)
}

export interface ReflectionPortRequest {
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

/** One reserved run, already prepared by the parent: its worktree exists and its transcript is written. */
export interface ReflectionChildLaunch {
  readonly runId: string
  readonly parentSessionId: string
  /** `ReflectionWorktree.dir` of the run. */
  readonly worktreeDir: string
  readonly transcriptPath: string
  readonly request: Pick<ReflectionRequest, "trigger" | "focus">
  /** The first user input; absent builds the reflection task prompt. A dream passes its own (`dream-inputs.ts`). */
  readonly prompt?: string
  /** `provider/model`; absent keeps the agent's own model. */
  readonly model?: string
  readonly variant?: string
  readonly fallbacks?: readonly ReflectionModelCandidate[]
  readonly deadlineMs: number
  /** Registers the parent's cancel; it closes the port (the child is interrupted and removed). */
  onCancel?(cancel: () => void): void
}

export type ReflectionChildResult = (
  | { readonly status: "completed"; readonly commits: readonly string[]; readonly report: MemoryChildTurnReport }
  | { readonly status: "failed" | "deadline"; readonly commits: readonly string[]; readonly detail: string }
  | { readonly status: "cancelled"; readonly commits: readonly string[] }
) & { readonly attemptedModels?: readonly string[] }

interface ReflectionChildHost {
  readonly app?: Context["app"]
  readonly session: object
}

export interface ReflectionChildHostingDeps {
  readonly host: ReflectionChildHost
  readonly createPort?: (request: ReflectionPortRequest) => MemoryChildPort
  readonly timers?: MemoryChildTimers
  readonly warn: (message: string, details?: Record<string, unknown>) => void
}

function isBackendSession(session: object): session is SessionBackendApi {
  return hasJoinedSessionCancellation(session)
}

export function createReflectionChildHosting(deps: ReflectionChildHostingDeps) {
  const scopes = createSessionScopes()
  const children = new Map<
    string,
    {
      readonly scope: ReflectionRunScope
      readonly lease: SessionLease
      priorAssistant: boolean
      retries: number
      boundedRetry: boolean
    }
  >()
  let closed = false

  function resolve(sessionID: string): ReflectionRunScope | undefined {
    const entry = children.get(sessionID)
    if (entry === undefined || closed) return undefined
    try {
      scopes.assert(entry.lease)
    } catch {
      return undefined
    }
    return entry.scope
  }

  function productionPort(request: ReflectionPortRequest): MemoryChildPort {
    const app = deps.host.app
    const session = deps.host.session
    if (app === undefined || !isBackendSession(session))
      throw new Error("Reflection child port requires the host app identity and the joined Effect session transport")
    return createMemoryChildPort({
      host: { app, session },
      directory: request.bound.directory,
      parentSessionId: request.parentSessionId,
      journalPath: request.journalPath,
      backendID: REFLECTION_BACKEND_ID,
      prefix: REFLECTION_CHILD_PREFIX,
      label: "Reflection",
      agent: request.agent,
      permissions: request.permissions,
      toolNames: request.toolNames,
      scopes: request.scopes,
      onIssued: request.onIssued,
      onRetired: request.onRetired,
    })
  }

  async function launch(bound: BoundMemorySession, input: ReflectionChildLaunch): Promise<ReflectionChildResult> {
    if (closed) return { status: "cancelled", commits: [] }
    const scope = createReflectionRunScope({
      runId: input.runId,
      worktreeDir: input.worktreeDir,
      transcriptPath: input.transcriptPath,
      agentId: bound.identity,
    })
    const request: ReflectionPortRequest = {
      bound,
      parentSessionId: input.parentSessionId,
      journalPath: reflectionChildJournalPath(bound),
      agent: input.request.trigger === "dream" ? DREAM_AGENT_ID : REFLECTION_AGENT_ID,
      permissions: REFLECTION_PERMISSIONS.map((rule) => ({ ...rule })),
      toolNames: [...REFLECTION_TOOL_NAMES],
      scopes,
      onIssued: (child) => {
        children.set(child.sessionID, {
          scope,
          lease: child.lease,
          priorAssistant: false,
          retries: 0,
          boundedRetry: (input.fallbacks?.length ?? 0) > 0,
        })
      },
      onRetired: (sessionID) => {
        children.delete(sessionID)
      },
    }
    const candidates =
      input.model === undefined
        ? [undefined]
        : [{ model: input.model, variant: input.variant }, ...(input.fallbacks ?? [])]
    const attemptedModels: string[] = []
    let port: MemoryChildPort | undefined
    let stopped = false
    input.onCancel?.(() => {
      stopped = true
      scope.deactivate()
      void port?.close().catch((error: unknown) => {
        deps.warn("reflection child cancel incomplete", { runId: input.runId, error: String(error) })
      })
    })
    const startedAt = Date.now()
    try {
      for (const candidate of candidates) {
        if (stopped || closed) return { status: "cancelled", commits: scope.commits(), attemptedModels }
        if (candidate !== undefined && attemptedModels.includes(candidate.model)) continue
        const remaining = input.deadlineMs - (Date.now() - startedAt)
        if (remaining <= 0)
          return {
            status: "deadline",
            commits: scope.commits(),
            detail: "reflection model chain exhausted its deadline",
            attemptedModels,
          }
        if (candidate !== undefined) attemptedModels.push(candidate.model)
        port = deps.createPort?.(request) ?? productionPort(request)
        let failure: unknown
        let detail = "reflection child turn failed"
        let initial = true
        try {
          const model =
            candidate === undefined
              ? undefined
              : {
                  ...Model.Ref.parse(candidate.model),
                  ...(candidate.variant === undefined
                    ? {}
                    : { variant: candidate.variant as NonNullable<ReturnType<typeof Model.Ref.parse>["variant"]> }),
                }
          const settled = await reflectionAttempt(
            port,
            {
              generation: attemptedModels.length || 1,
              prompt: input.prompt ?? buildReflectionTaskPrompt(input.request),
              ...(model === undefined ? {} : { model }),
            },
            remaining,
            deps.timers,
          )
          if (settled === "deadline")
            return {
              status: "deadline",
              commits: scope.commits(),
              detail: `reflection child did not settle within ${input.deadlineMs} ms`,
              attemptedModels,
            }
          if (settled.status === "cancelled" || stopped)
            return { status: "cancelled", commits: scope.commits(), attemptedModels }
          if (settled.status === "completed")
            return { status: "completed", commits: scope.commits(), report: settled, attemptedModels }
          failure = settled.error ?? settled.message
          detail = settled.message ?? detail
        } catch (error) {
          failure = error
          detail = error instanceof Error ? error.message : String(error)
        } finally {
          initial = [...children.values()]
            .filter((entry) => entry.scope === scope)
            .every((entry) => !entry.priorAssistant)
          await port.close()
          port = undefined
        }
        if (!initial || scope.commits().length > 0 || !retryableReflectionModelFailure(failure))
          return { status: "failed", commits: scope.commits(), detail, attemptedModels }
        if (candidate === candidates.at(-1))
          return { status: "failed", commits: scope.commits(), detail, attemptedModels }
      }
      return {
        status: "failed",
        commits: scope.commits(),
        detail: "reflection model candidates exhausted",
        attemptedModels,
      }
    } catch (error) {
      return {
        status: "failed",
        commits: scope.commits(),
        detail: error instanceof Error ? error.message : String(error),
        attemptedModels,
      }
    } finally {
      scope.deactivate()
      await port?.close().catch((error: unknown) => {
        deps.warn("reflection child cleanup incomplete", { runId: input.runId, error: String(error) })
      })
    }
  }

  return {
    launch,
    isReflectionSession: (sessionID: string): boolean => children.has(sessionID),
    /** The four reflection tools, to add once through `tool.transform`. */
    tools: (): readonly Info[] => createReflectionTools(resolve),
    /** Native memory-child chains allow one same-model retry before rotating to another rung. */
    onRetry(value: SessionRetry): void {
      const child = children.get(value.sessionID)
      if (child === undefined || !child.boundedRetry || child.priorAssistant) return
      child.retries += 1
      if (child.retries > 1 || !retryableReflectionModelFailure(value.error)) value.decision = { retry: false }
      else value.decision = { retry: true, delay: value.decision.retry ? Math.min(value.decision.delay, 2000) : 2000 }
    },
    /** True when the request belongs to a reflection child (narrowed to its four tools; nothing else applies). */
    onContext(value: Pick<SessionContext, "sessionID" | "tools"> & Partial<Pick<SessionContext, "messages">>): boolean {
      const names = new Set<string>(REFLECTION_TOOL_NAMES)
      if (!children.has(value.sessionID)) {
        for (const name of names) Reflect.deleteProperty(value.tools, name)
        return false
      }
      const child = children.get(value.sessionID)
      if (child !== undefined && value.messages?.some((message) => message.role === "assistant"))
        child.priorAssistant = true
      for (const name of Object.keys(value.tools)) if (!names.has(name)) Reflect.deleteProperty(value.tools, name)
      return true
    },
    close(): void {
      closed = true
      for (const entry of children.values()) entry.scope.deactivate()
      children.clear()
      scopes.dispose()
    },
  }
}

export type ReflectionChildHosting = ReturnType<typeof createReflectionChildHosting>
