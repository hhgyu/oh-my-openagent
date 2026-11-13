// Controlled UNIT doubles for the Kibitzer lifecycle: a scripted child port (each turn settles only
// when the test says so), a counting wake slot and manual timers. Never spawns OpenCode.
import type { KibitzerWakeAdmission, KibitzerWakeSlot } from "@oh-my-opencode/memory-core/recall-sidecar"
import type {
  KibitzerChild,
  KibitzerChildModel,
  KibitzerChildPort,
  KibitzerChildTurnReport,
  KibitzerModelPick,
  KibitzerSidecarTimers,
} from "./contract"
import type { KibitzerPortRequest } from "./component"

export interface Deferred<T> {
  readonly promise: Promise<T>
  resolve(value: T): void
  reject(error: unknown): void
}

export function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((yes, no) => {
    resolve = yes
    reject = no
  })
  return { promise, resolve, reject }
}

export interface ScriptedChild extends KibitzerChild {
  /** The model the seed staged the child with. */
  readonly model: KibitzerChildModel | undefined
  readonly prompts: string[]
  readonly followUps: string[]
  readonly steers: string[]
  aborts: number
  disposed: boolean
  /** Settles the current turn with this report (completed by default). */
  finish(report?: Partial<KibitzerChildTurnReport>): void
}

export interface ScriptedPort extends KibitzerChildPort {
  readonly children: ScriptedChild[]
  closed: boolean
  /** Next `start` rejects with this error once. */
  failNextStart: Error | undefined
  /** Next `start` waits for this promise before answering. */
  holdNextStart: Promise<void> | undefined
  /** What every `resolveModel` answers; a resolved scripted model by default. */
  pick: KibitzerModelPick
  /** Resolves when the n-th child (1-based) has started. */
  started(count: number): Promise<ScriptedChild>
}

export function createScriptedPort(request?: KibitzerPortRequest): ScriptedPort {
  const waiters: { count: number; resolve(child: ScriptedChild): void }[] = []
  const port: ScriptedPort = {
    children: [],
    closed: false,
    failNextStart: undefined,
    holdNextStart: undefined,
    pick: { kind: "resolved", model: { model: "scripted/quick" } },
    resolveModel: async () => port.pick,
    async start(input) {
      const hold = port.holdNextStart
      port.holdNextStart = undefined
      if (hold !== undefined) await hold
      const failure = port.failNextStart
      port.failNextStart = undefined
      if (failure !== undefined) throw failure
      const sessionID = `ses_kibitzer_${port.children.length + 1}`
      const lease = request?.scopes.open(sessionID as Parameters<KibitzerPortRequest["scopes"]["open"]>[0], {
        tools: [],
        authorize: () => undefined,
      })
      let turn = deferred<KibitzerChildTurnReport>()
      const child: ScriptedChild = {
        sessionID,
        generation: input.generation,
        model: input.model,
        prompts: [input.prompt],
        followUps: [],
        steers: [],
        aborts: 0,
        disposed: false,
        async followUp(text) {
          child.followUps.push(text)
          turn = deferred()
        },
        async steer(text) {
          child.steers.push(text)
        },
        async abort() {
          child.aborts += 1
          turn.resolve({ status: "completed", userTexts: [...child.prompts, ...child.followUps] })
        },
        waitForIdle: () => turn.promise,
        async dispose() {
          if (child.disposed) return
          child.disposed = true
          if (lease !== undefined && !lease.signal.aborted) request?.scopes.retire(lease)
          request?.onRetired(sessionID)
        },
        finish(report = {}) {
          turn.resolve({
            status: "completed",
            userTexts: [...child.prompts, ...child.followUps, ...child.steers],
            ...report,
          })
        },
      }
      if (lease !== undefined) request?.onIssued({ sessionID, lease })
      port.children.push(child)
      for (const waiter of waiters.filter((entry) => entry.count === port.children.length)) waiter.resolve(child)
      return child
    },
    async close() {
      port.closed = true
    },
    started(count) {
      const existing = port.children[count - 1]
      if (existing !== undefined) return Promise.resolve(existing)
      return new Promise((resolve) => {
        waiters.push({ count, resolve })
      })
    },
  }
  return port
}

export interface CountingSlot extends KibitzerWakeSlot {
  live: number
  acquired: number
  released: number
  /** Next acquire answers with this verdict (or throws it when it is an Error). */
  next: KibitzerWakeAdmission["status"] | Error | undefined
}

export function createCountingSlot(): CountingSlot {
  const slot: CountingSlot = {
    maxConcurrent: 2,
    live: 0,
    acquired: 0,
    released: 0,
    next: undefined,
    async acquire() {
      const next = slot.next
      slot.next = undefined
      if (next instanceof Error) throw next
      if (next === "busy") return { status: "busy", waitedMs: 15_000 }
      if (next === "aborted") return { status: "aborted" }
      slot.live += 1
      slot.acquired += 1
      let released = false
      return {
        status: "acquired",
        waitedMs: 3,
        lease: {
          slot: 1,
          async release() {
            if (released) return false
            released = true
            slot.live -= 1
            slot.released += 1
            return true
          },
        },
      }
    },
  }
  return slot
}

export interface ManualTimers extends KibitzerSidecarTimers {
  pending(): number
  /** Fires every armed timer whose delay is at most `ms`. */
  fire(ms?: number): void
}

export function createManualTimers(): ManualTimers {
  const armed = new Map<number, { callback: () => void; ms: number }>()
  let next = 0
  return {
    set(callback, ms) {
      next += 1
      armed.set(next, { callback, ms })
      return next
    },
    clear(handle) {
      if (typeof handle === "number") armed.delete(handle)
    },
    pending: () => armed.size,
    fire(ms = Number.POSITIVE_INFINITY) {
      for (const [handle, entry] of [...armed]) {
        if (entry.ms > ms) continue
        armed.delete(handle)
        entry.callback()
      }
    },
  }
}

/** Resolves after every queued microtask and one macrotask turn. */
export function flush(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0))
}
