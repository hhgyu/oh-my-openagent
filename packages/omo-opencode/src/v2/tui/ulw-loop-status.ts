import {
  ULW_LOOP_FOOTER_FRAME_INTERVAL_MS,
  ULW_LOOP_FOOTER_FRAMES,
} from "@oh-my-opencode/omo-codex/ulw-loop-session-sdk/loop-continuation"
import { ulwLoopStatusSchema } from "../rpc/ulw-loop"

export interface UlwLoopFooterTimers {
  set(callback: () => void, ms: number): unknown
  clear(handle: unknown): void
}

const realTimers: UlwLoopFooterTimers = {
  set: (callback, ms) => setInterval(callback, ms),
  clear: (handle) => clearInterval(handle as ReturnType<typeof setInterval>),
}

export function createUlwLoopFooterView(deps: {
  readonly load: (sessionID: string, signal: AbortSignal) => Promise<unknown>
  readonly subscribe: (handler: (data: unknown) => void) => () => void
  readonly changed: () => void
  readonly timers?: UlwLoopFooterTimers
}) {
  const timers = deps.timers ?? realTimers
  let sessionID: string | undefined
  let active = false
  let goal: string | undefined
  let frameIndex = 0
  let ticker: unknown
  let request: AbortController | undefined
  let closed = false
  const setActive = (next: boolean) => {
    if (next === active) return
    active = next
    frameIndex = 0
    if (active)
      ticker = timers.set(() => {
        frameIndex = (frameIndex + 1) % ULW_LOOP_FOOTER_FRAMES.length
        deps.changed()
      }, ULW_LOOP_FOOTER_FRAME_INTERVAL_MS)
    else if (ticker !== undefined) {
      timers.clear(ticker)
      ticker = undefined
    }
    deps.changed()
  }
  const setGoal = (next: string | undefined) => {
    if (next === goal) return
    goal = next
    deps.changed()
  }
  const accept = (data: unknown): boolean => {
    const result = ulwLoopStatusSchema.safeParse(data)
    if (closed || !result.success || result.data.sessionID !== sessionID) return false
    setActive(result.data.active)
    setGoal(result.data.goal)
    return true
  }
  const unsubscribe = deps.subscribe((data) => {
    if (accept(data)) request?.abort()
  })
  return {
    select(id: string): void {
      if (closed || sessionID === id) return
      request?.abort()
      sessionID = id
      setActive(false)
      setGoal(undefined)
      const controller = new AbortController()
      request = controller
      void deps
        .load(id, controller.signal)
        .then((data) => {
          if (!controller.signal.aborted) accept(data)
        })
        .catch(() => {})
    },
    frame(): string | undefined {
      const parts = [active ? ULW_LOOP_FOOTER_FRAMES[frameIndex] : undefined, goal].filter(
        (part): part is string => part !== undefined,
      )
      return parts.length === 0 ? undefined : parts.join("  ")
    },
    close(): void {
      closed = true
      request?.abort()
      unsubscribe()
      if (ticker !== undefined) timers.clear(ticker)
      ticker = undefined
    },
  }
}
