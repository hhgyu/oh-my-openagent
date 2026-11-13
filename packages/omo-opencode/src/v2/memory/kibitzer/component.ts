// The live V2 Kibitzer composition (port of omo-senpi `kibitzer/index.ts`): ONE resident sidecar per
// bound main session, created lazily on the session's first hook while `memory.recall.enabled` is
// on (the only off switch), built from the identity paths (`recall/sidecars/<encoded-session>/` for
// the child journal and `wakes.ndjson`, `runtime/locks` for the machine-wide wake slot) and closed
// on unload. Parent hooks only capture events; the recall collector hands its lexical candidates to
// `offer`; accepted nudges are marked surfaced and queued as pending nudges, which the existing
// recall delivery drains into the parent's next model request. Tool calls from Kibitzer children
// only feed the wake budget.

import { join } from "node:path"
import {
  GitMemoryRepo,
  type RecallCandidate,
  type RecallCorpus,
  type RecallCorpusCache,
  type RecallNudge,
} from "@oh-my-opencode/memory-core"
import { existsSync } from "@oh-my-opencode/memory-core/fs"
import {
  createKibitzerWakeSlot,
  kibitzerSidecarSessionDir,
  kibitzerWakesFile,
  KIBITZER_SIDECAR_TOOL_NAMES,
  type KibitzerWakeSlot,
} from "@oh-my-opencode/memory-core/recall-sidecar"
import type { OmoMemoryRecall } from "@oh-my-opencode/omo-config-core"
import type { Context } from "@opencode/plugin/promise/plugin"
import type { SessionContext } from "@opencode/plugin/promise/session"
import type { Info } from "@opencode/plugin/promise/tool"
import { z } from "zod"
import { hasJoinedSessionCancellation } from "../../host/session-cancellation"
import { createSessionScopes, type SessionLease } from "../../host/session-state"
import type { SessionBackendApi } from "../../host/session-backend"
import type { BoundMemorySession, MemoryBinder } from "../binding"
import { resolveRecallSettings, type MemoryLogger } from "../config"
import { RECALL_SURFACE_HASH, type RecallStores } from "../recall"
import { KIBITZER_AGENT_ID, KIBITZER_PERMISSIONS } from "./agent"
import { createKibitzerChildPort, KIBITZER_JOURNAL_FILENAME, type IssuedKibitzerChild } from "./child-port"
import type { KibitzerChildPort, KibitzerOfferResult, KibitzerSidecarTimers } from "./contract"
import { contentText } from "./events"
import { createKibitzerWakeRecorder } from "./observe"
import type { KibitzerModelResolution } from "./model"
import type { KibitzerWakeOutcome } from "./outcome"
import { createKibitzerSidecar, type KibitzerSidecar } from "./sidecar"
import {
  createKibitzerTools,
  KIBITZER_MEMORY_DESCRIPTION,
  KIBITZER_MEMORY_TOOL_NAME,
  KIBITZER_PRIVATE_TOOL_NAMES,
  kibitzerMemoryInput,
  wrapMemoryTool,
  type KibitzerToolsDeps,
} from "./tools"

export interface KibitzerPortRequest {
  readonly bound: BoundMemorySession
  readonly parentSessionId: string
  readonly journalPath: string
  onIssued(child: IssuedKibitzerChild): void
  onRetired(sessionID: string): void
  readonly scopes: ReturnType<typeof createSessionScopes>
}

/** Test seams: the child port, the wake slot, timers, and a hook after every recorded wake. */
export interface KibitzerSeams {
  readonly createPort?: (request: KibitzerPortRequest) => KibitzerChildPort
  readonly createWakeSlot?: (bound: BoundMemorySession, recall: OmoMemoryRecall) => KibitzerWakeSlot
  readonly timers?: KibitzerSidecarTimers
  readonly onWake?: (outcome: KibitzerWakeOutcome) => void
}

export interface KibitzerHost {
  readonly app?: Context["app"]
  readonly session: object
}

/** Only the public Effect session bridge (or a controlled test fake) carries the joined-cancellation token. */
function isBackendSession(session: object): session is SessionBackendApi {
  return hasJoinedSessionCancellation(session)
}

export interface KibitzerComponentDeps extends KibitzerSeams {
  readonly host: KibitzerHost
  readonly binder: MemoryBinder
  readonly stores: RecallStores
  readonly corpusCache: RecallCorpusCache
  readonly logger: MemoryLogger
  readonly now: () => number
  /** Recall-category model for a production seed; without it no production child is ever staged. */
  readonly resolveModel?: (bound: BoundMemorySession) => Promise<KibitzerModelResolution>
}

export interface KibitzerComponent {
  isKibitzerSession(sessionID: string): boolean
  onPrompt(sessionID: string, text: string): void
  onToolBefore(event: {
    readonly sessionID: string
    readonly tool: string
    readonly id: string
    readonly input: unknown
  }): void
  onToolAfter(event: {
    readonly sessionID: string
    readonly tool: string
    readonly id: string
    readonly status: string
    readonly result?: unknown
    readonly error?: unknown
  }): void
  /** Returns true when the request belongs to a Kibitzer child (its tools were narrowed; nothing else applies). */
  onContext(value: Pick<SessionContext, "sessionID" | "tools" | "messages">): boolean
  /** Tool exposure only, for every model request (compaction included): a child is narrowed to its contract tools, any other session loses the child-only ones. True for a child. */
  narrowTools(value: Pick<SessionContext, "sessionID" | "tools">): boolean
  offer(
    bound: BoundMemorySession,
    candidates: readonly RecallCandidate[],
    surfaced: ReadonlySet<string>,
    recall: OmoMemoryRecall,
  ): Promise<KibitzerOfferResult | undefined>
  tools<S extends z.ZodObject<z.ZodRawShape>>(memory: Info<S>): readonly Info[]
  activeSessions(): readonly string[]
  whenIdle(): Promise<void>
  close(): Promise<void>
}

interface SessionRecord {
  readonly bound: BoundMemorySession
  readonly sidecar: KibitzerSidecar
}

const KIBITZER_MEMORY_SCHEMA = z.toJSONSchema(kibitzerMemoryInput)

/** The production owned-child capability: verified OpenCode 2.2.6 plus the joined Effect session transport. */
export function kibitzerHostCapable(host: KibitzerHost): boolean {
  return host.app?.version === "2.2.6" && isBackendSession(host.session)
}

export function createKibitzerComponent(deps: KibitzerComponentDeps): KibitzerComponent {
  const scopes = createSessionScopes()
  const records = new Map<string, Promise<SessionRecord | undefined>>()
  const children = new Map<string, { readonly sidecar: KibitzerSidecar; readonly lease: SessionLease }>()
  const chains = new Map<string, Promise<unknown>>()
  const recorder = createKibitzerWakeRecorder({
    now: deps.now,
    warn: (message, details) => deps.logger.warn(message, details),
  })
  let closed = false

  function queue<T>(sessionID: string, work: () => Promise<T>): Promise<T | undefined> {
    const next = (chains.get(sessionID) ?? Promise.resolve()).then(work).catch((error: unknown) => {
      deps.logger.warn("kibitzer hook skipped", {
        sessionID,
        error: error instanceof Error ? error.message : String(error),
      })
      return undefined
    })
    chains.set(sessionID, next)
    void next.then(() => {
      if (chains.get(sessionID) === next) chains.delete(sessionID)
    })
    return next
  }

  function recordFor(sessionID: string): Promise<SessionRecord | undefined> {
    let pending = records.get(sessionID)
    if (pending === undefined) {
      pending = create(sessionID)
      records.set(sessionID, pending)
    }
    return pending
  }

  async function create(sessionID: string): Promise<SessionRecord | undefined> {
    const bound = await deps.binder.resolve(sessionID)
    if (bound === undefined || closed) return undefined
    const recall = resolveRecallSettings(bound.settings, bound.identity)
    if (!recall.enabled) return undefined
    const sessionDir = kibitzerSidecarSessionDir(bound.paths.recall, sessionID)
    const request: KibitzerPortRequest = {
      bound,
      parentSessionId: sessionID,
      journalPath: join(sessionDir, KIBITZER_JOURNAL_FILENAME),
      scopes,
      onIssued: (child) => {
        children.set(child.sessionID, { sidecar, lease: child.lease })
      },
      onRetired: (childID) => {
        children.delete(childID)
      },
    }
    const port = deps.createPort?.(request) ?? productionPort(request)
    const wakesFile = kibitzerWakesFile(bound.paths.recall, sessionID)
    const sidecar = createKibitzerSidecar({
      sessionId: sessionID,
      port,
      deliver: (nudges) => deliver(bound, nudges),
      onWake: (outcome) => {
        recorder.record(wakesFile, outcome)
        deps.onWake?.(outcome)
      },
      wakeSlot:
        deps.createWakeSlot?.(bound, recall) ??
        createKibitzerWakeSlot({ locksDirectory: bound.paths.locks, maxConcurrent: recall.max_concurrent_wakes }),
      toolBudget: recall.tool_budget,
      sidecarMaxTokens: recall.sidecar_max_tokens,
      eventCaps: {
        toolArgs: recall.event_caps.tool_args,
        resultHead: recall.event_caps.result_head,
        assistant: recall.event_caps.assistant,
        prompt: recall.event_caps.prompt,
      },
      now: deps.now,
      ...(deps.timers === undefined ? {} : { timers: deps.timers }),
      warn: (message, details) => deps.logger.warn(message, details),
    })
    return { bound, sidecar }
  }

  function productionPort(request: KibitzerPortRequest): KibitzerChildPort {
    const app = deps.host.app
    const session = deps.host.session
    if (app === undefined || !isBackendSession(session))
      throw new Error("Kibitzer child port requires the host app identity and the joined Effect session transport")
    const resolveModel = deps.resolveModel
    return createKibitzerChildPort({
      resolveModel: async () =>
        resolveModel?.(request.bound) ?? {
          kind: "unavailable",
          category: resolveRecallSettings(request.bound.settings, request.bound.identity).category,
          detail: "Kibitzer has no recall model resolver",
        },
      host: { app, session },
      directory: request.bound.directory,
      parentSessionId: request.parentSessionId,
      journalPath: request.journalPath,
      agent: KIBITZER_AGENT_ID,
      permissions: KIBITZER_PERMISSIONS.map((rule) => ({ ...rule })),
      toolNames: KIBITZER_SIDECAR_TOOL_NAMES,
      scopes: request.scopes,
      onIssued: request.onIssued,
      onRetired: request.onRetired,
    })
  }

  async function deliver(bound: BoundMemorySession, nudges: readonly RecallNudge[]): Promise<void> {
    // Senpi delivery marks the ledger at accept time so the collector never re-offers the path.
    try {
      await deps.stores.ledger(bound).markSurfaced(
        bound.sessionID,
        nudges.map((nudge) => ({ path: nudge.path, hash: RECALL_SURFACE_HASH })),
      )
    } catch (error) {
      deps.logger.warn("kibitzer delivery ledger mark skipped", {
        sessionID: bound.sessionID,
        error: error instanceof Error ? error.message : String(error),
      })
    }
    const pending = deps.stores.pending(bound)
    const queued = await pending.take(bound.sessionID)
    const seen = new Set<string>()
    const merged = [...queued, ...nudges].filter((nudge) => !seen.has(nudge.path) && seen.add(nudge.path) !== undefined)
    await pending.write(bound.sessionID, merged)
  }

  /** A live issued child: its lease is current AND it is the owning sidecar's current child. */
  function resolveCaller(sessionID: string): ReturnType<KibitzerToolsDeps["resolve"]> {
    const entry = children.get(sessionID)
    if (entry === undefined || closed) return undefined
    try {
      scopes.assert(entry.lease)
    } catch {
      return undefined
    }
    const binding = entry.sidecar.toolBinding(sessionID)
    return binding === undefined ? undefined : { sidecar: entry.sidecar, binding }
  }

  async function corpus(parentSessionId: string): Promise<RecallCorpus | undefined> {
    const bound = await deps.binder.resolve(parentSessionId)
    if (bound === undefined || !existsSync(join(bound.paths.repo, ".git"))) return undefined
    return deps.corpusCache.load(new GitMemoryRepo({ dir: bound.paths.repo, agentId: bound.identity }))
  }

  const toolDeps: KibitzerToolsDeps = { resolve: resolveCaller, corpus }

  function capture(sessionID: string, apply: (sidecar: KibitzerSidecar) => void): void {
    if (closed || children.has(sessionID)) return
    void queue(sessionID, async () => {
      const record = await recordFor(sessionID)
      if (record !== undefined) apply(record.sidecar)
    })
  }

  function narrowTools(value: Pick<SessionContext, "sessionID" | "tools">): boolean {
    if (!children.has(value.sessionID)) {
      for (const name of KIBITZER_PRIVATE_TOOL_NAMES) Reflect.deleteProperty(value.tools, name)
      return false
    }
    // Exposure follows the child's permissions: only the five contract tools, `memory` read-only.
    for (const name of Object.keys(value.tools))
      if (!(KIBITZER_SIDECAR_TOOL_NAMES as readonly string[]).includes(name)) Reflect.deleteProperty(value.tools, name)
    if (value.tools[KIBITZER_MEMORY_TOOL_NAME] !== undefined)
      value.tools[KIBITZER_MEMORY_TOOL_NAME] = {
        description: KIBITZER_MEMORY_DESCRIPTION,
        input: KIBITZER_MEMORY_SCHEMA,
      }
    return true
  }

  return {
    isKibitzerSession: (sessionID) => children.has(sessionID),
    onPrompt(sessionID, text) {
      capture(sessionID, (sidecar) => {
        sidecar.events.onPrompt(text)
      })
    },
    onToolBefore(event) {
      const child = children.get(event.sessionID)
      if (child !== undefined) {
        child.sidecar.observeChildTool(event.sessionID, "start", event.id)
        return
      }
      capture(event.sessionID, (sidecar) => {
        sidecar.events.onToolCall(event.tool, event.id, event.input)
      })
    },
    onToolAfter(event) {
      const child = children.get(event.sessionID)
      if (child !== undefined) {
        child.sidecar.observeChildTool(event.sessionID, "end", event.id)
        return
      }
      const isError = event.status !== "completed"
      capture(event.sessionID, (sidecar) => {
        sidecar.events.onToolResult(event.tool, event.id, isError, isError ? event.error : event.result)
      })
    },
    narrowTools,
    onContext(value) {
      if (narrowTools(value)) return true
      const text = newestAssistantText(value.messages)
      if (text !== undefined)
        capture(value.sessionID, (sidecar) => {
          sidecar.events.onAssistant(text)
        })
      return false
    },
    async offer(bound, candidates, surfaced, recall) {
      if (closed) return undefined
      return queue(bound.sessionID, async () => {
        const record = await recordFor(bound.sessionID)
        if (record === undefined) return undefined
        return record.sidecar.offer({ candidates, surfaced, maxItems: recall.max_items })
      })
    },
    tools(memory) {
      return [wrapMemoryTool(memory, toolDeps), ...createKibitzerTools(toolDeps)]
    },
    activeSessions: () => [...records.keys()],
    async whenIdle() {
      while (chains.size > 0) await Promise.allSettled([...chains.values()])
      for (const pending of [...records.values()]) await (await pending)?.sidecar.whenIdle()
      await recorder.idle()
    },
    async close() {
      closed = true
      await Promise.allSettled([...chains.values()])
      const settled = await Promise.allSettled(
        [...records.values()].map(async (pending) => (await pending)?.sidecar.shutdown()),
      )
      records.clear()
      children.clear()
      scopes.dispose()
      await recorder.idle()
      const failures = settled.filter((result): result is PromiseRejectedResult => result.status === "rejected")
      if (failures.length > 0)
        throw new AggregateError(
          failures.map((failure) => failure.reason),
          "Kibitzer shutdown incomplete",
        )
    },
  }
}

/** The newest assistant message's text in a model request, tolerant of unknown message shapes. */
function newestAssistantText(messages: readonly unknown[]): string | undefined {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index]
    if (message === null || typeof message !== "object" || Array.isArray(message)) continue
    const record = message as Record<string, unknown>
    if (record.role !== "assistant") continue
    const text = contentText(record.content).trim()
    return text === "" ? undefined : text
  }
  return undefined
}
