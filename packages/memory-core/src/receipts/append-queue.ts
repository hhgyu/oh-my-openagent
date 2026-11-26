// Coalesces same-process work per key. A caller that arrives while a flush for its key is pending or
// running joins the next flush, so N concurrent callers in one process cost one flush (one cross-process
// lock acquisition, one fsync) instead of N independent contenders polling the same lock file.
//
// Every caller keeps the bound it had when it waited on the lock by itself: its deadline starts when it
// submits, and a caller whose batch has not been taken by then is removed from the queue and rejected, so
// its input is never written after it has been told it failed. `take` re-checks every deadline against
// the clock, so a late timer callback cannot let an overdue input through, and a full queue rejects new
// submissions at once instead of growing without bound. A taken input is never dropped: its caller
// resolves after the flush succeeds or rejects with the flush's error.

export type CoalescedFlush<I, R> = (
  key: string,
  take: () => readonly I[],
  waitTimeoutMs: number,
) => Promise<readonly R[]>

export interface CoalescingQueueOptions {
  /** How long one caller may wait for its batch to be taken. */
  readonly deadlineMs: number
  /** The most inputs one flush takes; the rest wait for the next flush. */
  readonly maxBatch: number
  /** The most inputs one key holds waiting to be taken; a submission past it is rejected at once. */
  readonly maxPending: number
  /** The error a caller gets when its deadline passes before its batch is taken, or the queue is full. */
  readonly expired: (key: string) => Error
  readonly now?: () => number
  readonly schedule?: (delayMs: number, run: () => void) => () => void
}

export interface CoalescingQueue<I, R> {
  submit(key: string, input: I): Promise<R>
}

interface Pending<I, R> {
  readonly input: I
  readonly deadline: number
  readonly resolve: (result: R) => void
  readonly reject: (error: unknown) => void
  cancelTimer: () => void
}

function rejectOverdue<I, R>(queue: Pending<I, R>[], at: number, error: unknown): void {
  rejectAll(
    queue,
    queue.filter((pending) => pending.deadline <= at),
    error,
  )
}

function rejectCoveredBy<I, R>(queue: Pending<I, R>[], latestDeadline: number, error: unknown): void {
  rejectAll(
    queue,
    queue.filter((pending) => pending.deadline <= latestDeadline),
    error,
  )
}

function rejectAll<I, R>(queue: Pending<I, R>[], rejected: readonly Pending<I, R>[], error: unknown): void {
  for (const pending of rejected) {
    queue.splice(queue.indexOf(pending), 1)
    pending.cancelTimer()
    pending.reject(error)
  }
}

function scheduleWithTimer(delayMs: number, run: () => void): () => void {
  const timer = setTimeout(run, delayMs)
  return () => clearTimeout(timer)
}

/**
 * `flush` receives a `take` callback and calls it at most once, after it holds whatever exclusion it
 * needs, and a `waitTimeoutMs` it must not wait longer than for that exclusion (the latest deadline among
 * the queued callers). `take` rejects every input already past its deadline, then hands over up to
 * `maxBatch` of the rest in submission order; `flush` returns one
 * result per taken input, in the same order. A flush that throws before `take` rejects, with its error,
 * every queued caller whose deadline its wait covered; callers that arrived later get a flush of their own.
 */
export function createCoalescingQueue<I, R>(
  flush: CoalescedFlush<I, R>,
  options: CoalescingQueueOptions,
): CoalescingQueue<I, R> {
  const now = options.now ?? Date.now
  const schedule = options.schedule ?? scheduleWithTimer
  const positiveInteger = (value: number) => Number.isInteger(value) && value >= 1
  if (options.deadlineMs <= 0 || !positiveInteger(options.maxBatch) || !positiveInteger(options.maxPending))
    throw new Error("coalescing queue needs a positive deadline, batch size and pending limit")
  const queues = new Map<string, Pending<I, R>[]>()

  async function drain(key: string, queue: Pending<I, R>[]): Promise<void> {
    while (queue.length > 0) {
      let taken: Pending<I, R>[] | undefined
      const latestDeadline = Math.max(...queue.map((pending) => pending.deadline))
      try {
        const results = await flush(
          key,
          () => {
            if (taken !== undefined) throw new Error("coalesced flush took its batch twice")
            rejectOverdue(queue, now(), options.expired(key))
            taken = queue.splice(0, options.maxBatch)
            for (const pending of taken) pending.cancelTimer()
            return taken.map((pending) => pending.input)
          },
          Math.max(0, latestDeadline - now()),
        )
        const batch = taken ?? []
        if (results.length !== batch.length) throw new Error("coalesced flush returned a result per input")
        batch.forEach((pending, index) => pending.resolve(results[index] as R))
      } catch (error) {
        if (taken !== undefined) for (const pending of taken) pending.reject(error)
        else rejectCoveredBy(queue, latestDeadline, error)
      }
    }
    queues.delete(key)
  }

  return {
    submit(key, input) {
      return new Promise<R>((resolve, reject) => {
        const existing = queues.get(key)
        if (existing !== undefined && existing.length >= options.maxPending) {
          reject(options.expired(key))
          return
        }
        const pending: Pending<I, R> = {
          input,
          deadline: now() + options.deadlineMs,
          resolve,
          reject,
          cancelTimer: () => undefined,
        }
        const queue = existing ?? []
        queue.push(pending)
        pending.cancelTimer = schedule(options.deadlineMs, () => {
          const index = queue.indexOf(pending)
          if (index === -1) return
          queue.splice(index, 1)
          reject(options.expired(key))
        })
        if (existing !== undefined) return
        queues.set(key, queue)
        void drain(key, queue)
      })
    },
  }
}
