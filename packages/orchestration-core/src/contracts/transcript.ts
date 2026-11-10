export type TranscriptEntry =
  | { readonly kind: "assistant"; readonly text: string }
  | { readonly kind: "tool"; readonly tool: string; readonly is_error: boolean }
  | { readonly kind: "error"; readonly message: string }

export type TranscriptSource = "event-log" | "session-jsonl" | "none"

export type TranscriptReadResult = {
  readonly entries: readonly TranscriptEntry[]
  readonly source: TranscriptSource
  readonly truncated?: boolean
}

export type TranscriptReader = (input: { readonly taskId: string; readonly stateDir: string }) => TranscriptReadResult

// Structural output of transcript projection; Native store redaction/persistence stays adapter-owned.
export type ProjectedTranscriptEvent = {
  readonly type: string
  readonly payload: unknown
}
