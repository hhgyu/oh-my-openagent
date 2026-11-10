// The resident child over the V2 owned-session backend (`host/session-backend.ts`), the same custody
// path native tasks use (`orchestration/native-task/owned-runner.ts`): a durable child journal under
// the identity's `runtime/recall/sidecars/<encoded-session>/`, `stage` with the hidden `kibitzer`
// agent and deny-all-but-five session permissions, the first input through `begin`, later input
// through `promptContinuation` (queued for a follow-up, steered into a running turn), settlement
// through `wait`, the cancel through `interrupt`, and unload through `close` (interrupt, wait,
// remove, durable CLOSED row) then `dispose`. Nothing here calls `session.prompt` directly and no
// native-task guard custody is involved.

import { randomUUID } from "node:crypto"
import type { Context } from "@opencode/plugin/promise/plugin"
import { openChildJournal, type DurableChildJournal } from "../../host/child-journal"
import { createSessionBackend, SessionBackendError, type ChildHandle, type SessionBackendApi } from "../../host/session-backend"
import type { SessionLease, SessionScopes, SessionToolPolicy } from "../../host/session-state"
import type { KibitzerChild, KibitzerChildPort, KibitzerChildTurnReport } from "./contract"

const KIBITZER_BACKEND_ID = "omo-kibitzer-opencode"
export const KIBITZER_JOURNAL_FILENAME = "children.sqlite"

type Backend = ReturnType<typeof createSessionBackend>
type Permissions = Parameters<Backend["stage"]>[0]["permissions"]

export interface IssuedKibitzerChild {
  readonly sessionID: string
  readonly lease: SessionLease
}

export interface KibitzerChildPortDeps {
  readonly host: { readonly app: Context["app"]; readonly session: SessionBackendApi }
  readonly directory: string
  readonly parentSessionId: string
  readonly journalPath: string
  readonly agent: string
  readonly permissions: Permissions
  readonly toolNames: readonly string[]
  /** Component-owned scopes: the parent lease and each child lease are opened here. */
  readonly scopes: SessionScopes
  onIssued(child: IssuedKibitzerChild): void
  onRetired(sessionID: string): void
  readonly newId?: () => string
}

const PARENT_POLICY: SessionToolPolicy = {
  tools: [],
  authorize: () => { throw new Error("The Kibitzer parent scope grants no tools") },
}

export function createKibitzerChildPort(deps: KibitzerChildPortDeps): KibitzerChildPort {
  const newId = deps.newId ?? (() => randomUUID().replaceAll("-", ""))
  const childPolicy: SessionToolPolicy = { tools: [...deps.toolNames], authorize: () => undefined }
  let parent: SessionLease | undefined
  let journal: DurableChildJournal | undefined
  let backend: Backend | undefined
  let closed = false
  let closing: Promise<void> | undefined
  const live = new Set<KibitzerChild>()

  async function ensure(): Promise<Backend> {
    if (closed) throw new SessionBackendError("stopped", "Kibitzer child port closed")
    if (backend !== undefined) return backend
    journal ??= await openChildJournal({ path: deps.journalPath })
    if (closed) throw new SessionBackendError("stopped", "Kibitzer child port closed")
    parent ??= deps.scopes.open(deps.parentSessionId as SessionLease["sessionID"], PARENT_POLICY)
    backend = createSessionBackend({ app: deps.host.app, location: { directory: deps.directory }, session: deps.host.session }, {
      backendID: KIBITZER_BACKEND_ID, owner: journal.owner, parent, scopes: deps.scopes, policy: childPolicy, journal,
      gate: { assertActive() { if (closed) throw new SessionBackendError("stopped", "Kibitzer child port closed") } },
    })
    return backend
  }

  async function start(input: { readonly generation: number; readonly prompt: string }): Promise<KibitzerChild> {
    const owner = await ensure()
    const sessionID = `ses_kibitzer_${newId()}` as SessionLease["sessionID"]
    const handle = await owner.stage({ key: `kibitzer:${input.generation}:${sessionID}`, sessionID, agent: deps.agent, permissions: deps.permissions })
    deps.onIssued({ sessionID, lease: handle.lease })
    const child = wrap(owner, handle, input.generation)
    try {
      await owner.begin(handle, { id: `msg_kibitzer_${newId()}`, text: input.prompt })
    } catch (error) {
      await child.dispose().catch(() => undefined)
      throw error
    }
    live.add(child)
    return child
  }

  function wrap(owner: Backend, handle: ChildHandle, generation: number): KibitzerChild {
    let disposal: Promise<void> | undefined
    let turnStartedAt = Date.now()
    const child: KibitzerChild = {
      sessionID: handle.locator.sessionID,
      generation,
      async followUp(text: string) {
        turnStartedAt = Date.now()
        await owner.promptContinuation(handle, { id: `msg_kibitzer_${newId()}`, text, delivery: "queue", resume: true })
      },
      async steer(text: string) {
        await owner.promptContinuation(handle, { id: `msg_kibitzer_${newId()}`, text, delivery: "steer", resume: true })
      },
      async abort() {
        await owner.interrupt(handle)
      },
      async waitForIdle(): Promise<KibitzerChildTurnReport> {
        try {
          await owner.wait(handle)
          return turnReport(await owner.currentContext(handle), turnStartedAt)
        } catch (error) {
          if (handle.lease.signal.aborted || disposal !== undefined || closed) return { status: "cancelled", userTexts: [] }
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
        for (const result of await Promise.allSettled([...live].map(child => child.dispose()))) if (result.status === "rejected") failures.push(result.reason)
        closed = true
        try { await backend?.dispose() } catch (error) { failures.push(error) }
        if (parent !== undefined && !parent.signal.aborted) {
          try { deps.scopes.retire(parent) } catch (error) { failures.push(error) }
        }
        // A child whose cleanup stayed uncertain keeps its durable custody row for a later owner.
        journal?.close()
        if (failures.length > 0) throw new AggregateError(failures, "Kibitzer child cleanup incomplete")
      })()
      return closing
    },
  }
}

/** The settled turn read off the child's own transcript; tolerant of unknown message shapes. */
export function turnReport(messages: readonly unknown[], turnStartedAt: number): KibitzerChildTurnReport {
  const userTexts: string[] = []
  let last: Record<string, unknown> | undefined
  let usage: { input: number; output: number; cacheRead: number; cacheWrite: number } | undefined
  for (const message of messages) {
    if (!isRecord(message)) continue
    if (message.type === "user" && typeof message.text === "string") userTexts.push(message.text)
    if (message.type !== "assistant") continue
    last = message
    const created = isRecord(message.time) && typeof message.time.created === "number" ? message.time.created : Number.POSITIVE_INFINITY
    const tokens = message.tokens
    if (created < turnStartedAt || !isRecord(tokens)) continue
    const cache = isRecord(tokens.cache) ? tokens.cache : {}
    const previous = usage ?? { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }
    usage = {
      input: previous.input + numberOf(tokens.input), output: previous.output + numberOf(tokens.output),
      cacheRead: previous.cacheRead + numberOf(cache.read), cacheWrite: previous.cacheWrite + numberOf(cache.write),
    }
  }
  const model = last !== undefined && isRecord(last.model) && typeof last.model.providerID === "string" && typeof last.model.id === "string"
    ? `${last.model.providerID}/${last.model.id}` : undefined
  const tokens = last !== undefined && isRecord(last.tokens) ? last.tokens : undefined
  const contextTokens = tokens === undefined ? undefined : numberOf(tokens.input) + numberOf(isRecord(tokens.cache) ? tokens.cache.read : 0)
  const error = last?.error
  const failed = error !== undefined && error !== null
  return {
    status: failed ? "error" : "completed",
    ...(failed ? { message: errorMessage(error) } : {}),
    ...(model === undefined ? {} : { model }),
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
