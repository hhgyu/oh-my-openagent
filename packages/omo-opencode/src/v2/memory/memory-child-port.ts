// A memory-owned hidden child over the V2 owned-session backend (`host/session-backend.ts`), the same
// custody path native tasks use (`orchestration/native-task/owned-runner.ts`): a durable child journal,
// `stage` with one hidden agent, its deny-all-but-N session permissions and an optional model, the
// first input through `begin`, later input through `promptContinuation` (queued for a follow-up,
// steered into a running turn), settlement through `wait` (bounded by `settleWithin`), the cancel
// through `interrupt`, and unload through `close` (interrupt, wait, remove, durable CLOSED row) then
// `dispose`. The Kibitzer judge and the facts extractor both run on it. Nothing here calls
// `session.prompt` directly and no native-task guard custody is involved.

import { randomUUID } from "node:crypto"
import type { Context } from "@opencode/plugin/promise/plugin"
import { openChildJournal, type DurableChildJournal } from "../host/child-journal"
import {
  createSessionBackend,
  SessionBackendError,
  type ChildHandle,
  type SessionBackendApi,
} from "../host/session-backend"
import type { SessionLease, SessionScopes, SessionToolPolicy } from "../host/session-state"

type Backend = ReturnType<typeof createSessionBackend>
type StageInput = Parameters<Backend["stage"]>[0]
export type MemoryChildPermissions = StageInput["permissions"]
type MemoryChildModel = StageInput["model"]

/** How one child turn settled, read from the child's own transcript after it went idle. */
export interface MemoryChildTurnReport {
  readonly status: "completed" | "error" | "cancelled"
  readonly message?: string
  /** Structured host error retained for the model-attempt classifier, never persisted verbatim. */
  readonly error?: unknown
  /** `provider/model` of the newest assistant message. */
  readonly model?: string
  readonly variant?: string
  /** Provider usage summed over the turn's assistant messages. */
  readonly usage?: {
    readonly input: number
    readonly output: number
    readonly cacheRead: number
    readonly cacheWrite: number
  }
  /** `input + cacheRead + cacheWrite` of the newest assistant message. */
  readonly contextTokens?: number
  /** User texts the child transcript holds, so an owner can confirm which steers it read. */
  readonly userTexts: readonly string[]
}

/** One live owned child. Every input goes through the owner's gated admission paths. */
export interface MemoryChild {
  readonly sessionID: string
  readonly generation: number
  /** Revives an idle child with a fresh turn (queued delivery). */
  followUp(text: string): Promise<void>
  /** Joins the running turn (steer delivery). */
  steer(text: string): Promise<void>
  /** Interrupts the running turn; settlement still reports through `waitForIdle`. */
  abort(): Promise<void>
  /** Resolves once the current turn has settled. */
  waitForIdle(): Promise<MemoryChildTurnReport>
  /** Closes the child and releases its custody. Idempotent. */
  dispose(): Promise<void>
}

export interface MemoryChildStartInput {
  readonly generation: number
  readonly prompt: string
  /** Per-launch model; absent keeps the agent's own model. */
  readonly model?: MemoryChildModel
}

export interface MemoryChildPort {
  /** Starts one child with its first turn already admitted. */
  start(input: MemoryChildStartInput): Promise<MemoryChild>
  /** Releases everything the port owns (children, backend, journal). Idempotent. */
  close(): Promise<void>
}

export interface IssuedMemoryChild {
  readonly sessionID: string
  readonly lease: SessionLease
}

export interface MemoryChildPortDeps {
  readonly host: { readonly app: Context["app"]; readonly session: SessionBackendApi }
  readonly directory: string
  readonly parentSessionId: string
  readonly journalPath: string
  /** Backend identity written into every child locator. */
  readonly backendID: string
  /** Lower-case ID segment: `ses_<prefix>_<id>`, `msg_<prefix>_<id>`, custody key `<prefix>:<generation>:<session>`. */
  readonly prefix: string
  /** Human label for refusals ("Kibitzer", "Facts"). */
  readonly label: string
  readonly agent: string
  readonly permissions: MemoryChildPermissions
  readonly toolNames: readonly string[]
  /** Component-owned scopes: the parent lease and each child lease are opened here. */
  readonly scopes: SessionScopes
  onIssued(child: IssuedMemoryChild): void
  onRetired(sessionID: string): void
  readonly newId?: () => string
}

/** Injectable timers: production uses unref'd runtime timers; tests fire them by hand. */
export interface MemoryChildTimers {
  set(callback: () => void, ms: number): unknown
  clear(handle: unknown): void
}

const runtimeMemoryChildTimers: MemoryChildTimers = {
  set(callback, ms) {
    const handle = setTimeout(callback, ms)
    handle.unref?.()
    return handle
  },
  clear(handle) {
    if (handle !== undefined) clearTimeout(handle as Parameters<typeof clearTimeout>[0])
  },
}

export function createMemoryChildPort(deps: MemoryChildPortDeps): MemoryChildPort {
  const newId = deps.newId ?? (() => randomUUID().replaceAll("-", ""))
  const closedError = () => new SessionBackendError("stopped", `${deps.label} child port closed`)
  const parentPolicy: SessionToolPolicy = {
    tools: [],
    authorize: () => {
      throw new Error(`The ${deps.label} parent scope grants no tools`)
    },
  }
  const childPolicy: SessionToolPolicy = { tools: [...deps.toolNames], authorize: () => undefined }
  let parent: SessionLease | undefined
  let journal: DurableChildJournal | undefined
  let backend: Backend | undefined
  let closed = false
  let closing: Promise<void> | undefined
  const live = new Set<MemoryChild>()

  async function ensure(): Promise<Backend> {
    if (closed) throw closedError()
    if (backend !== undefined) return backend
    journal ??= await openChildJournal({ path: deps.journalPath })
    if (closed) throw closedError()
    parent ??= deps.scopes.open(deps.parentSessionId as SessionLease["sessionID"], parentPolicy)
    backend = createSessionBackend(
      { app: deps.host.app, location: { directory: deps.directory }, session: deps.host.session },
      {
        backendID: deps.backendID,
        owner: journal.owner,
        parent,
        scopes: deps.scopes,
        policy: childPolicy,
        journal,
        gate: {
          assertActive() {
            if (closed) throw closedError()
          },
        },
      },
    )
    return backend
  }

  async function start(input: MemoryChildStartInput): Promise<MemoryChild> {
    const owner = await ensure()
    const sessionID = `ses_${deps.prefix}_${newId()}` as SessionLease["sessionID"]
    const handle = await owner.stage({
      key: `${deps.prefix}:${input.generation}:${sessionID}`,
      sessionID,
      agent: deps.agent,
      permissions: deps.permissions,
      ...(input.model === undefined ? {} : { model: input.model }),
    })
    deps.onIssued({ sessionID, lease: handle.lease })
    const child = wrap(owner, handle, input.generation)
    try {
      await owner.begin(handle, { id: `msg_${deps.prefix}_${newId()}`, text: input.prompt })
    } catch (error) {
      await child.dispose().catch(() => undefined)
      throw error
    }
    live.add(child)
    return child
  }

  function wrap(owner: Backend, handle: ChildHandle, generation: number): MemoryChild {
    let disposal: Promise<void> | undefined
    let turnStartedAt = Date.now()
    const child: MemoryChild = {
      sessionID: handle.locator.sessionID,
      generation,
      async followUp(text: string) {
        turnStartedAt = Date.now()
        await owner.promptContinuation(handle, {
          id: `msg_${deps.prefix}_${newId()}`,
          text,
          delivery: "queue",
          resume: true,
        })
      },
      async steer(text: string) {
        await owner.promptContinuation(handle, {
          id: `msg_${deps.prefix}_${newId()}`,
          text,
          delivery: "steer",
          resume: true,
        })
      },
      async abort() {
        await owner.interrupt(handle)
      },
      async waitForIdle(): Promise<MemoryChildTurnReport> {
        try {
          await owner.wait(handle)
          return turnReport(await owner.currentContext(handle), turnStartedAt)
        } catch (error) {
          if (handle.lease.signal.aborted || disposal !== undefined || closed)
            return { status: "cancelled", userTexts: [] }
          throw error
        }
      },
      dispose(): Promise<void> {
        disposal ??= (async () => {
          live.delete(child)
          try {
            await owner.close(handle)
          } finally {
            deps.onRetired(handle.locator.sessionID)
          }
        })()
        return disposal
      },
    }
    return child
  }

  return {
    start,
    close(): Promise<void> {
      closing ??= (async () => {
        const failures: unknown[] = []
        for (const result of await Promise.allSettled([...live].map((child) => child.dispose())))
          if (result.status === "rejected") failures.push(result.reason)
        closed = true
        try {
          await backend?.dispose()
        } catch (error) {
          failures.push(error)
        }
        if (parent !== undefined && !parent.signal.aborted) {
          try {
            deps.scopes.retire(parent)
          } catch (error) {
            failures.push(error)
          }
        }
        // A child whose cleanup stayed uncertain keeps its durable custody row for a later owner.
        journal?.close()
        if (failures.length > 0) throw new AggregateError(failures, `${deps.label} child cleanup incomplete`)
      })()
      return closing
    },
  }
}

/**
 * Waits for the child's current turn, bounded by `deadlineMs`. On the deadline the turn is
 * interrupted and `"deadline"` is returned; the caller still disposes the child.
 */
export async function settleWithin(
  child: MemoryChild,
  deadlineMs: number,
  timers: MemoryChildTimers = runtimeMemoryChildTimers,
): Promise<MemoryChildTurnReport | "deadline"> {
  let handle: unknown
  const deadline = new Promise<"deadline">((resolve) => {
    handle = timers.set(() => resolve("deadline"), Math.max(0, deadlineMs))
  })
  try {
    const settled = await Promise.race([child.waitForIdle(), deadline])
    if (settled === "deadline") await child.abort().catch(() => undefined)
    return settled
  } finally {
    timers.clear(handle)
  }
}

/** The settled turn read off the child's own transcript; tolerant of unknown message shapes. */
export function turnReport(messages: readonly unknown[], turnStartedAt: number): MemoryChildTurnReport {
  const userTexts: string[] = []
  let last: Record<string, unknown> | undefined
  let usage: { input: number; output: number; cacheRead: number; cacheWrite: number } | undefined
  for (const message of messages) {
    if (!isRecord(message)) continue
    if (message.type === "user" && typeof message.text === "string") userTexts.push(message.text)
    if (message.type !== "assistant") continue
    last = message
    const created =
      isRecord(message.time) && typeof message.time.created === "number"
        ? message.time.created
        : Number.POSITIVE_INFINITY
    const tokens = message.tokens
    if (created < turnStartedAt || !isRecord(tokens)) continue
    const cache = isRecord(tokens.cache) ? tokens.cache : {}
    const previous = usage ?? { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }
    usage = {
      input: previous.input + numberOf(tokens.input),
      output: previous.output + numberOf(tokens.output),
      cacheRead: previous.cacheRead + numberOf(cache.read),
      cacheWrite: previous.cacheWrite + numberOf(cache.write),
    }
  }
  const model =
    last !== undefined &&
    isRecord(last.model) &&
    typeof last.model.providerID === "string" &&
    typeof last.model.id === "string"
      ? `${last.model.providerID}/${last.model.id}`
      : undefined
  const variant =
    last !== undefined && isRecord(last.model) && typeof last.model.variant === "string"
      ? last.model.variant
      : undefined
  const tokens = last !== undefined && isRecord(last.tokens) ? last.tokens : undefined
  const lastCache = tokens !== undefined && isRecord(tokens.cache) ? tokens.cache : {}
  // A cold prompt cache reports most of the prompt as cache.write, so it counts toward the context too.
  const contextTokens =
    tokens === undefined ? undefined : numberOf(tokens.input) + numberOf(lastCache.read) + numberOf(lastCache.write)
  const error = last?.error
  const failed = error !== undefined && error !== null
  return {
    status: failed ? "error" : "completed",
    ...(failed ? { message: errorMessage(error), error } : {}),
    ...(model === undefined ? {} : { model }),
    ...(variant === undefined ? {} : { variant }),
    ...(usage === undefined ? {} : { usage }),
    ...(contextTokens === undefined ? {} : { contextTokens }),
    userTexts,
  }
}

function errorMessage(error: unknown): string {
  if (isRecord(error)) {
    if (typeof error.message === "string") return error.message
    if (isRecord(error.data) && typeof error.data.message === "string") return error.data.message
  }
  return typeof error === "string" ? error : "child turn failed"
}

function numberOf(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
}
