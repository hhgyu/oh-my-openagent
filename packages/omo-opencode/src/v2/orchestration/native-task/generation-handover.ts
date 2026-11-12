import { resolve } from "node:path"

/** One plugin generation of a project directory that is closing right now in THIS process. */
interface Retirement {
  readonly order: number
  /** Settles (never rejects) once that generation's close has finished or failed. */
  readonly settled: Promise<void>
}

interface HandoverRegistry {
  issued: number
  readonly retiring: Map<string, Set<Retirement>>
}

// Process-wide on purpose. An in-process location reload or evict builds the next plugin generation
// while the previous one is still open: OpenCode keeps a borrowed location (and so the previous
// plugin) alive until its running steps let go. A reloaded plugin may also evaluate its modules
// again, so a module-level map could miss the generation it replaces.
const REGISTRY = Symbol.for("oh-my-openagent.v2.native-task.generation-handover")

function isRegistry(value: unknown): value is HandoverRegistry {
  return typeof value === "object" && value !== null && "issued" in value && typeof value.issued === "number"
    && "retiring" in value && value.retiring instanceof Map
}

function registry(): HandoverRegistry {
  const existing: unknown = Reflect.get(globalThis, REGISTRY)
  if (isRegistry(existing)) return existing
  const created: HandoverRegistry = { issued: 0, retiring: new Map() }
  Reflect.set(globalThis, REGISTRY, created)
  return created
}

/** How long a call of a newer generation waits for an older one to finish parking. OpenCode warns
 * after the same 30 s that a shut-down location is still held (`location still held after shutdown`). */
export const PREDECESSOR_WAIT_MS = 30_000

export class PredecessorParkTimeout extends Error {
  constructor(waitedMs: number) {
    super(`The previous plugin generation of this project is still parking its Native task children after ${Math.round(waitedMs / 1000)} s; no task row was read. Retry the call once it has finished.`)
    this.name = "PredecessorParkTimeout"
  }
}

function waitBounded(work: Promise<unknown>, signal: AbortSignal | undefined, deadline: number, waitedFrom: number): Promise<void> {
  signal?.throwIfAborted()
  return new Promise<void>((resolveWait, rejectWait) => {
    const finish = (settle: () => void) => { clearTimeout(timer); signal?.removeEventListener("abort", abort); settle() }
    const abort = () => finish(() => rejectWait(signal?.reason))
    const timer = setTimeout(() => finish(() => rejectWait(new PredecessorParkTimeout(Date.now() - waitedFrom))), Math.max(0, deadline - Date.now()))
    signal?.addEventListener("abort", abort, { once: true })
    void work.then(() => finish(resolveWait))
  })
}

export interface NativeGenerationHandover {
  /** Runs this generation's close as its retirement: a NEWER generation of the same directory waits
   * for it before its first call reads any task row. The caller memoizes the close. */
  retire(close: () => Promise<void>): Promise<void>
  /** Resolves once no OLDER generation of the same directory is closing in this process. A
   * predecessor's close failing still counts as settled: its rows stay as that close left them,
   * and the child journal keeps refusing any custody whose owner never released it. The wait is
   * bounded (`PREDECESSOR_WAIT_MS` by default): past it the call fails with
   * `PredecessorParkTimeout` instead of reading rows the predecessor may still drive. */
  predecessorsSettled(signal?: AbortSignal, timeoutMs?: number): Promise<void>
}

/** The handover between plugin generations of one project directory in this process. OpenCode runs
 * a plugin's close only when the location's last borrower lets go, so the previous generation
 * parks its children on the host's shutdown signal instead and the next generation waits for that
 * park; a row the previous generation still holds is never read as a live child of this host. */
export function enterNativeGeneration(directory: string): NativeGenerationHandover {
  const shared = registry(), key = resolve(directory), order = ++shared.issued
  return Object.freeze({
    retire(close: () => Promise<void>): Promise<void> {
      let work: Promise<void>
      try { work = close() } catch (error) { work = Promise.reject(error) }
      const retirement: Retirement = { order, settled: work.then(() => undefined, () => undefined) }
      const set = shared.retiring.get(key) ?? new Set<Retirement>()
      shared.retiring.set(key, set)
      set.add(retirement)
      void retirement.settled.then(() => {
        set.delete(retirement)
        if (set.size === 0 && shared.retiring.get(key) === set) shared.retiring.delete(key)
      })
      return work
    },
    async predecessorsSettled(signal?: AbortSignal, timeoutMs = PREDECESSOR_WAIT_MS): Promise<void> {
      const startedAt = Date.now(), deadline = startedAt + timeoutMs
      for (;;) {
        const pending = [...shared.retiring.get(key) ?? []].filter(retirement => retirement.order < order).map(retirement => retirement.settled)
        if (pending.length === 0) return
        try { await waitBounded(Promise.all(pending), signal, deadline, startedAt) }
        catch (error) {
          if (error instanceof PredecessorParkTimeout) console.warn("[oh-my-openagent/v2] Native task call refused: the previous plugin generation did not finish parking", { directory: key, waitedMs: Date.now() - startedAt })
          throw error
        }
      }
    },
  })
}
