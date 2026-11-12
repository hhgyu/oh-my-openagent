import { isUltraworkInput } from "@oh-my-opencode/prompts-core/ultrawork-keyword"
import { ultraworkPromptVariants } from "@oh-my-opencode/prompts-core"

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
  arm(sessionID: string): void
  observePrompt(sessionID: string, text: string): void
  disarm(sessionID: string): void
  compact(sessionID: string, eventID?: string): void
  resume(sessionID: string): void
  claimReminder(sessionID: string): boolean
  resetReminder(sessionID: string): void
}

/**
 * Shared directive and fanout state. Compaction drops arming until the next model request;
 * retiring a plugin generation does not end its sessions.
 */
function createPromptArmingLedger(): PromptArmingLedger {
  const armed = new Set<string>()
  const pending = new Set<string>()
  const reminded = new Set<string>()
  const compactions = new Map<string, string>()
  const arm = (sessionID: string) => {
    armed.add(sessionID)
    pending.delete(sessionID)
  }
  return {
    isArmed: sessionID => armed.has(sessionID),
    arm,
    observePrompt(sessionID, text) {
      if (isUltraworkPrompt(text)) arm(sessionID)
    },
    disarm(sessionID) {
      armed.delete(sessionID)
      pending.delete(sessionID)
      reminded.delete(sessionID)
      compactions.delete(sessionID)
    },
    compact(sessionID, eventID) {
      if (eventID !== undefined && compactions.get(sessionID) === eventID) return
      if (eventID !== undefined) compactions.set(sessionID, eventID)
      armed.delete(sessionID)
      pending.add(sessionID)
      reminded.delete(sessionID)
    },
    resume(sessionID) { if (pending.has(sessionID)) arm(sessionID) },
    claimReminder(sessionID) {
      if (reminded.has(sessionID)) return false
      reminded.add(sessionID)
      return true
    },
    resetReminder(sessionID) { reminded.delete(sessionID) },
  }
}

const SHARED_ARMING = Symbol.for("omo.v2.ultrawork.arming")
interface Registry {
  readonly revision: string
  readonly directories: Map<string, PromptArmingLedger>
  readonly hosts: WeakMap<object, PromptArmingLedger>
}

export function sharedPromptArmingLedger(host: object & { readonly location?: { readonly directory: string } }): PromptArmingLedger {
  const globals = globalThis as unknown as Record<symbol, Registry | undefined>
  const revision = JSON.stringify(ultraworkPromptVariants)
  let registry = globals[SHARED_ARMING]
  if (registry?.revision !== revision) {
    registry = { revision, directories: new Map(), hosts: new WeakMap() }
    globals[SHARED_ARMING] = registry
  }
  const directory = host.location?.directory
  const existing = directory === undefined ? registry.hosts.get(host) : registry.directories.get(directory)
  if (existing !== undefined) return existing
  const ledger = createPromptArmingLedger()
  if (directory === undefined) registry.hosts.set(host, ledger)
  else registry.directories.set(directory, ledger)
  return ledger
}
