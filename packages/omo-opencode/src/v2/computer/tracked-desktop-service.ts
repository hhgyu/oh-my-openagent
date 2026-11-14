import { DesktopEngineAbiMismatchError, DesktopLaunchContextError } from "@oh-my-opencode/senpi-desktop-engine"
import type { EngineMethod, PermissionDeniedData, StopPathStatus } from "@oh-my-opencode/senpi-desktop-protocol"
import {
  type CallOptions,
  DesktopEngineRpcError,
  DesktopEngineUnavailableError,
  DesktopService,
  type DesktopServiceOptions,
  type DesktopSessionOpenParams,
} from "@oh-my-opencode/senpi-desktop-service"

export type EngineState =
  "not started" | "ready" | "native-unavailable" | "quarantined" | "abi-mismatch" | "launch-context-unavailable"

type Diagnostic = Exclude<EngineState, "not started" | "ready">

class ComputerEngineUnavailableError extends Error {
  override readonly name = "ComputerEngineUnavailableError"
  readonly diagnostic: Diagnostic

  constructor(diagnostic: Diagnostic, cause: Error) {
    super(`Computer use is unavailable (${diagnostic}): ${cause.message}`, { cause })
    this.diagnostic = diagnostic
  }
}

function diagnosticOf(error: Error): Diagnostic | undefined {
  if (error instanceof DesktopEngineUnavailableError) return error.diagnostic.code
  if (error instanceof DesktopEngineAbiMismatchError) return "abi-mismatch"
  if (error instanceof DesktopLaunchContextError) return error.code
  return undefined
}

export interface TrackedDesktopServiceOptions extends DesktopServiceOptions {
  readonly onError?: (error: Error) => void
  readonly onPermissionRequired?: (permission: Pick<PermissionDeniedData, "permission" | "app">) => void
}

/** A `DesktopService` that remembers whether its engine started, so `/omo:computer status` never has to start one. */
export class TrackedDesktopService extends DesktopService {
  #engineState: EngineState = "not started"
  readonly #onError: TrackedDesktopServiceOptions["onError"]
  readonly #onPermissionRequired: TrackedDesktopServiceOptions["onPermissionRequired"]

  constructor(options: TrackedDesktopServiceOptions = {}) {
    super(options)
    this.#onError = options.onError
    this.#onPermissionRequired = options.onPermissionRequired
    this.onError((error) => this.#report(error))
  }

  get engineState(): EngineState {
    return this.#engineState
  }

  override async open(params: DesktopSessionOpenParams): ReturnType<DesktopService["open"]> {
    try {
      const capabilities = await super.open(params)
      this.#engineState = "ready"
      return capabilities
    } catch (error) {
      if (!(error instanceof Error)) throw error
      this.#report(error)
      if (error instanceof DesktopLaunchContextError) throw error
      const diagnostic = diagnosticOf(error)
      if (diagnostic === undefined) throw error
      throw new ComputerEngineUnavailableError(diagnostic, error)
    }
  }

  override call(method: EngineMethod, params: unknown, options: CallOptions = {}): Promise<unknown> {
    return this.#observe(super.call(method, params, options))
  }

  override ensureStopPath(chord: string): Promise<StopPathStatus> {
    return this.#observe(super.ensureStopPath(chord))
  }

  override stopPathStatus(): Promise<StopPathStatus> {
    return this.#observe(super.stopPathStatus())
  }

  override stop(): Promise<StopPathStatus> {
    return this.#observe(super.stop())
  }

  override resume(): Promise<StopPathStatus> {
    return this.#observe(super.resume())
  }

  async #observe<T>(operation: Promise<T>): Promise<T> {
    try {
      const result = await operation
      if (this.#engineState === "not started" || this.#engineState === "launch-context-unavailable") {
        this.#engineState = "ready"
      }
      return result
    } catch (error) {
      if (error instanceof Error) this.#report(error)
      throw error
    }
  }

  #report(error: Error): void {
    const diagnostic = diagnosticOf(error)
    if (diagnostic !== undefined) this.#engineState = diagnostic
    if (
      error instanceof DesktopEngineRpcError &&
      error.data !== null &&
      "code" in error.data &&
      error.data.code === "PermissionDenied" &&
      error.data.permission != null
    ) {
      this.#onPermissionRequired?.(error.data.permission)
    }
    this.#onError?.(error)
  }
}
