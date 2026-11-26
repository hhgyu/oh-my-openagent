// Coalesces same-process work per key. A caller that arrives while a flush for its key is pending or
// running joins the next flush, so N concurrent callers in one process cost one flush (one cross-process
// lock acquisition, one fsync) instead of N independent contenders polling the same lock file.

export type CoalescedFlush<I, R> = (key: string, take: () => readonly I[]) => Promise<readonly R[]>

export interface CoalescingQueue<I, R> {
  submit(key: string, input: I): Promise<R>
}

interface Pending<I, R> {
  readonly input: I
  readonly resolve: (result: R) => void
  readonly reject: (error: unknown) => void
}

/**
 * `flush` receives a `take` callback and must call it at most once, after it holds whatever exclusion
 * it needs: `take` hands over every input queued for the key so far, in submission order, and `flush`
 * returns one result per taken input, in the same order. Inputs queued after `take` wait for the next
 * flush. A flush that throws rejects the inputs it took, or every queued input when it took none.
 */
export function createCoalescingQueue<I, R>(flush: CoalescedFlush<I, R>): CoalescingQueue<I, R> {
  const queues = new Map<string, Pending<I, R>[]>()

  async function drain(key: string, queue: Pending<I, R>[]): Promise<void> {
    while (queue.length > 0) {
      let taken: Pending<I, R>[] | undefined
      try {
        const results = await flush(key, () => {
          if (taken !== undefined) throw new Error("coalesced flush took its batch twice")
          taken = queue.splice(0)
          return taken.map((pending) => pending.input)
        })
        const batch = taken ?? []
        if (results.length !== batch.length) throw new Error("coalesced flush returned a result per input")
        batch.forEach((pending, index) => pending.resolve(results[index] as R))
      } catch (error) {
        for (const pending of taken ?? queue.splice(0)) pending.reject(error)
      }
    }
    queues.delete(key)
  }

  return {
    submit(key, input) {
      return new Promise<R>((resolve, reject) => {
        const pending = { input, resolve, reject }
        const queue = queues.get(key)
        if (queue !== undefined) {
          queue.push(pending)
          return
        }
        const fresh = [pending]
        queues.set(key, fresh)
        void drain(key, fresh)
      })
    },
  }
}
