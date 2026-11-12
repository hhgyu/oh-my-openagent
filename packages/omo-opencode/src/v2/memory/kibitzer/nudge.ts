// The judge's only action (V2 port of omo-senpi `nudge-tool.ts` + `tools/nudge.ts`): call-time
// validation against the live allowed set `offered ∪ searched`, the session's surfaced ledger, the
// `system/` reservation, secret-like material (named first), memory-core's observation-only hint
// contract (`describeInvalidHint`) and the wake's `maxItems`. A rejection leaves the loop open for
// the one correction the contract allows.

import { containsSecretLikeMaterial, describeInvalidHint, type RecallNudge } from "@oh-my-opencode/memory-core"

export const KIBITZER_NUDGE_TOOL_NAME = "nudge"

export const KIBITZER_NUDGE_DESCRIPTION =
  "Surface one stored memory to the primary agent as a read-only hint. Call it only when the memory would change what the agent does next."
export const KIBITZER_NUDGE_HINT_DESCRIPTION =
  "One factual sentence stating what the stored note records ('the note records that ...'), at most 200 characters, on a single line. It is reference the agent reads, so never address it or tell it what to do: no second person, no imperative, no judgment about whether to nudge, and never filler such as 'placeholder'."

export interface NudgeCheckInput {
  readonly offered: ReadonlySet<string>
  readonly searched: ReadonlySet<string>
  readonly surfaced: ReadonlySet<string>
  readonly maxItems: number
  readonly accepted: readonly RecallNudge[]
}

function rejectNudge(
  params: { readonly path: string; readonly hint: string },
  input: NudgeCheckInput,
): string | undefined {
  if (!input.offered.has(params.path) && !input.searched.has(params.path))
    return `"${params.path}" is not one of the offered candidates.`
  if (input.surfaced.has(params.path)) return `"${params.path}" was already surfaced in this session.`
  if (params.path === "system/" || params.path.startsWith("system/"))
    return `"${params.path}" is a system/ path and cannot be nudged.`
  if (containsSecretLikeMaterial(params.hint)) return "The hint was rejected because it contains secret-like material."
  const invalidHint = describeInvalidHint(params.hint)
  if (invalidHint === "addresses-agent") {
    return "The hint addresses the agent (second person or imperative): restate what the note records as a plain observation."
  }
  if (invalidHint !== undefined) {
    return "The hint must state a memory fact in one non-empty line of at most 200 characters, not comment on whether the memory is relevant or worth nudging."
  }
  if (input.accepted.length >= input.maxItems)
    return `The maxItems limit (${input.maxItems}) for this run has been reached.`
  return undefined
}

export type NudgeResult =
  | { readonly ok: false; readonly message: string }
  | { readonly ok: true; readonly message: string; readonly capped: boolean }

/** Validates and, when admissible, records one nudge in the wake's accepted list. */
export function applyNudge(
  params: { readonly path: string; readonly hint: string },
  input: NudgeCheckInput & { readonly accepted: RecallNudge[] },
): NudgeResult {
  const rejection = rejectNudge(params, input)
  if (rejection !== undefined)
    return { ok: false, message: `Nudge rejected: ${rejection} Correct the call once, or end the run.` }
  input.accepted.push({ path: params.path, hint: params.hint })
  const capped = input.accepted.length >= input.maxItems
  return {
    ok: true,
    capped,
    message: capped
      ? `Nudge recorded for ${params.path}. The maxItems limit (${input.maxItems}) is reached; the run ends here.`
      : `Nudge recorded for ${params.path}.`,
  }
}
