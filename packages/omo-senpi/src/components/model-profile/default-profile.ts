import type { AuthFailure } from "./request-auth"

export type ProbeState = {
  readonly excludedProviders: Set<string>
  readonly excludedSelectors: Set<string>
  readonly failures: AuthFailure[]
}

/**
 * One credential-probe state per session start: the default walk tries several lanes, and a
 * provider whose credentials already failed is neither probed again nor reported twice.
 */
export const newProbeState = (): ProbeState => ({
  excludedProviders: new Set(),
  excludedSelectors: new Set(),
  failures: [],
})

export { resolveDefaultModelProfile } from "@oh-my-opencode/delegate-core/model-profile/default-profile"
