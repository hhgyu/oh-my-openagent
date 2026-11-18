/** How often, and for how long, startup recovery retries a parent whose left-behind children another live
 * runtime of the project claimed first. Native's live-parent recovery answers a waiting parent within five
 * minutes (`live-parent-recovery.ts`); the same window bounds this retry. */
const HELD_ELSEWHERE_RETRY_MS = 5_000
const HELD_ELSEWHERE_BUDGET_MS = 300_000

/** Startup recovery of one parent, repeated while another live runtime holds some of its children. Two
 * OpenCode processes can start on the same project (a `serve --service` restart replaces the previous
 * service, which shuts down after it); the one that lost the claim takes the children over once the holder
 * releases them, so a waiting parent still gets its answer. Stops when nothing is held elsewhere, the
 * budget is spent, or `signal` aborts. `initialDelay` waits one interval before the first attempt. */
export async function recoverWhileHeldElsewhere(
  recover: () => Promise<{ readonly elsewhere: readonly string[] } | undefined>,
  options: {
    readonly signal: AbortSignal
    readonly intervalMs?: number
    readonly budgetMs?: number
    readonly initialDelay?: boolean
  },
): Promise<void> {
  const interval = options.intervalMs ?? HELD_ELSEWHERE_RETRY_MS,
    deadline = Date.now() + (options.budgetMs ?? HELD_ELSEWHERE_BUDGET_MS)
  if (options.initialDelay && !(await pause(interval, options.signal))) return
  for (;;) {
    if (options.signal.aborted) return
    const report = await recover()
    if (!report || report.elsewhere.length === 0 || Date.now() + interval > deadline) return
    if (!(await pause(interval, options.signal))) return
  }
}

function pause(ms: number, signal: AbortSignal): Promise<boolean> {
  if (signal.aborted) return Promise.resolve(false)
  return new Promise((resolve) => {
    const done = (value: boolean) => {
      clearTimeout(timer)
      signal.removeEventListener("abort", aborted)
      resolve(value)
    }
    const aborted = () => done(false)
    const timer = setTimeout(() => done(true), ms)
    signal.addEventListener("abort", aborted, { once: true })
  })
}
