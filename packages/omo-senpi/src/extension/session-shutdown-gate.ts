import type { ComponentLogger, SenpiExtensionAPI } from "./types"

/**
 * Thrown by a guarded `sendMessage({ triggerTurn: true })` or `sendUserMessage` once this generation's
 * session_shutdown has begun. Senpi's own stale API also throws from these calls after a reload, so every
 * producer already treats a throw as "not delivered": the idle coordinator hands the batch back as a delivery
 * failure, senpi-task keeps `notified_epoch` unset, and the next session_start reconcile redelivers it.
 */
class SessionShutdownSendRefusedError extends Error {
  constructor(customType: string | undefined) {
    super(
      `omo-senpi refused a turn-starting send${customType === undefined ? "" : ` (${customType})`}: the session is shutting down`,
    )
    this.name = "SessionShutdownSendRefusedError"
  }
}

export interface SessionShutdownGate {
  readonly guard: (api: SenpiExtensionAPI) => SenpiExtensionAPI
}

function customTypeOf(message: unknown): string | undefined {
  if (typeof message !== "object" || message === null) return undefined
  const value: unknown = Reflect.get(message, "customType")
  return typeof value === "string" ? value : undefined
}

function startsTurn(options: unknown): boolean {
  return typeof options === "object" && options !== null && Reflect.get(options, "triggerTurn") === true
}

/**
 * Senpi dispatches session_shutdown handlers one after another and awaits each. While a slow handler (the
 * memory drain) is awaited, a timer-driven OmO wake could otherwise start a NEW turn on the session that is
 * being torn down; a builtin that already ran its shutdown handler then re-arms a timer on that turn's
 * lifecycle events and keeps a print-mode process alive. Install this BEFORE any other session_shutdown
 * handler so every component's API is gated from the first OmO shutdown handler on.
 */
export function installSessionShutdownGate(
  pi: Pick<SenpiExtensionAPI, "on">,
  logger: Pick<ComponentLogger, "warn">,
): SessionShutdownGate {
  let shuttingDown = false
  pi.on("session_shutdown", () => {
    shuttingDown = true
  })
  pi.on("session_start", () => {
    shuttingDown = false
  })

  const refuse = (customType: string | undefined): never => {
    const error = new SessionShutdownSendRefusedError(customType)
    logger.warn("omo-senpi refused a turn-starting send during session shutdown", { customType })
    throw error
  }

  return {
    guard(api) {
      const sendMessage: SenpiExtensionAPI["sendMessage"] = (message, options) => {
        if (shuttingDown && startsTurn(options)) refuse(customTypeOf(message))
        return api.sendMessage(message, options)
      }
      const sendUserMessage: SenpiExtensionAPI["sendUserMessage"] = (content, options) => {
        if (shuttingDown) refuse(undefined)
        api.sendUserMessage(content, options)
      }
      return new Proxy(api, {
        get(target, property) {
          if (property === "sendMessage") return sendMessage
          if (property === "sendUserMessage") return sendUserMessage
          const value: unknown = Reflect.get(target, property, target)
          return typeof value === "function" ? value.bind(target) : value
        },
      })
    },
  }
}
