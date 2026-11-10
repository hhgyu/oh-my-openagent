import { isUltraworkInput } from "@oh-my-opencode/prompts-core/ultrawork-keyword"

// Same keyword rule as Senpi's ultrawork arming: the shared Core detector arms only on the keyword
// as a word of its own, after quoted, injected, relayed and negated regions are blanked.
export function isUltraworkPrompt(text: string): boolean {
  return isUltraworkInput(text)
}

/** Read-only view of an ultrawork arming ledger, keyed by OpenCode 2 session ID. */
export interface TodoFanoutArming {
  isArmed(sessionID: string): boolean
}

export interface PromptArmingLedger extends TodoFanoutArming {
  observePrompt(sessionID: string, text: string): void
  disarm(sessionID: string): void
}

/**
 * V2 stand-in for Senpi's shared ultrawork arming ledger while no V2 ultrawork component exists:
 * a session arms when one of its prompts carries the ultrawork keyword, and an accepted compaction
 * or deletion disarms it (Senpi's `rearmOnCompact` likewise drops the armed state on compaction).
 */
export function createPromptArmingLedger(): PromptArmingLedger {
  const armed = new Set<string>()
  return {
    isArmed: sessionID => armed.has(sessionID),
    observePrompt(sessionID, text) {
      if (isUltraworkPrompt(text)) armed.add(sessionID)
    },
    disarm(sessionID) {
      armed.delete(sessionID)
    },
  }
}
