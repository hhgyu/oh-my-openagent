import type { TaskStartFailureKind, TaskStartFailureReason } from "./task-start-failure"

/** An interrupt the parent did not request: the host replaced the child's session mid-turn. */
export type TaskInterruptCause = "session_replaced"

/**
 * A closed, PARENT-AUTHORED classification of why a runner refused. Unlike `message`, no member is
 * ever derived from child output, so it is the one part of a failure that is safe to surface and
 * persist verbatim - and `manager.ts` still treats it only as a lookup key, never as text to echo.
 */
export type RunnerFailureReason = TaskStartFailureReason

export type RunnerFailure = {
  // The snake_case kinds map 1:1 onto the manager's respawn disposition codes (todo 12): a resume
  // rebuild failure is TYPED and retryable, never a silently weakened tool set or transcript.
  readonly kind: TaskStartFailureKind
  readonly message: string
  readonly reason?: RunnerFailureReason
  readonly cause?: unknown
  // Set only with `launch_spec_insecure`: the refused spec path omo resolved itself, never child
  // output, so the public start failure may name the file and its fix (#9208).
  readonly launch_spec_path?: string
  /**
   * Structured exit facts for the internal event log, when the child actually reached a process exit.
   *
   * `message` is stderr-derived (`runners/rpc/exit-mapping.ts`) and therefore untrusted child output,
   * so it must never reach a durable artifact - `manager.ts publicStartFailureMessage` collapses it for
   * exactly that reason. These are closed enums and numbers, which cannot carry a credential, so they
   * can be persisted and finally answer WHY a child died instead of only THAT it died.
   *
   * `rejected_while` is captured by the RPC runner before unstarted-handle cleanup: `alive` means
   * the initial command rejected while the child was still live, while `exited` means the child had
   * already produced the exit outcome. It is intentionally separate from `exit`, because cleanup
   * terminates a still-live child and must never be mistaken for the rejection's cause.
   *
   * Shape is inlined rather than imported from `../types`: that module imports RunnerOutcome from this
   * one, so importing back would close a cycle.
   */
  readonly rejected_while?: "alive" | "exited"
  readonly exit?: {
    readonly kind: "clean" | "killed" | "crashed" | "spawn_error"
    readonly code: number | null
    readonly signal: NodeJS.Signals | null
  }
}

export type RunnerOutcome =
  | { readonly status: "completed"; readonly finalResponse: string; readonly model?: string }
  | { readonly status: "error"; readonly failure: RunnerFailure; readonly killed?: boolean; readonly model?: string }
  | { readonly status: "cancelled" }
  // A run stopped for a reason the parent did not request: its session was replaced (cause, message), or
  // another client's user abort took it (F10a: partial text kept, abortedBy). Resumable; never a failure.
  | {
      readonly status: "interrupted"
      readonly cause?: TaskInterruptCause
      readonly message?: string
      readonly finalResponse?: string
      readonly abortedBy?: string
    }

export type ChildCompletionPolicy = "final-text" | "turn"

