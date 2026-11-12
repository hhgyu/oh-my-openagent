import { isRetryableModelError } from "@oh-my-opencode/model-core"
import type { MemoryChild, MemoryChildPort, MemoryChildStartInput, MemoryChildTimers, MemoryChildTurnReport } from "./memory-child-port"

/** Only provider failures are eligible; authentication and invalid input always stop the chain. */
export function retryableReflectionModelFailure(error: unknown): boolean {
  const record = error !== null && typeof error === "object" ? error : {}
  const nested = Reflect.get(record, "data")
  const data = nested !== null && typeof nested === "object" ? nested : record
  const message = typeof error === "string" ? error : String(Reflect.get(data, "message") ?? Reflect.get(record, "message") ?? "")
  const name = String(Reflect.get(record, "name") ?? "")
  const rawStatus = Reflect.get(data, "statusCode") ?? Reflect.get(data, "status")
  const statusCode = typeof rawStatus === "number" ? rawStatus : Number(/\b([45]\d\d)\b/.exec(message)?.[1])
  if ([400, 401, 403, 422].includes(statusCode) || /auth|api.?key|invalid.?request|permission.denied|unauthorized|forbidden/i.test(`${name} ${message}`)) return false
  if (statusCode === 404) return /model/i.test(message)
  if (statusCode >= 500 && statusCode <= 599) return true
  return /model.*(?:not.found|unavailable|not.available)|(?:not.found|unavailable).*model/i.test(`${name} ${message}`)
    || isRetryableModelError({ name, message, ...(Number.isFinite(statusCode) ? { statusCode } : {}) })
}

/** Includes child creation and its first turn in the same absolute run budget. */
export async function reflectionAttempt(port: MemoryChildPort, input: MemoryChildStartInput, ms: number, timers?: MemoryChildTimers): Promise<MemoryChildTurnReport | "deadline"> {
  const clock = timers ?? {
    set(callback: () => void, delay: number) { const handle = setTimeout(callback, delay); handle.unref?.(); return handle },
    clear(handle: unknown) { clearTimeout(handle as ReturnType<typeof setTimeout>) },
  }
  let handle: unknown
  let child: MemoryChild | undefined
  const expired = new Promise<"deadline">(resolve => { handle = clock.set(() => resolve("deadline"), ms) })
  try {
    const result = await Promise.race([port.start(input).then(started => { child = started; return started.waitForIdle() }), expired])
    if (result === "deadline") await child?.abort()
    return result
  } finally {
    clock.clear(handle)
  }
}
