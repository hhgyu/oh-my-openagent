// Liveness of the component instance that launched a facts run. One OpenCode server process can host
// several plugin instances (one per directory) and a reload replaces an instance inside the same
// process, so the pid alone cannot tell a live owner from a stranded one. Every live facts runtime
// registers its owner token in a process-global set; a ledger from this process is live only while its
// token is registered, and a ledger from another process is live while that process is.

import { getPidLiveness } from "@oh-my-opencode/memory-core"
import type { FactsRunLedger } from "./facts-run-store"

const OWNERS_KEY = Symbol.for("omo.v2.memory.facts.owners")

function owners(): Set<string> {
  const slot = globalThis as { [OWNERS_KEY]?: Set<string> }
  return (slot[OWNERS_KEY] ??= new Set())
}

export function registerFactsOwner(owner: string): void {
  owners().add(owner)
}

export function retireFactsOwner(owner: string): void {
  owners().delete(owner)
}

export function factsOwnerAlive(ledger: Pick<FactsRunLedger, "owner" | "pid">): boolean {
  if (ledger.pid === process.pid) return owners().has(ledger.owner)
  return getPidLiveness(ledger.pid) !== "dead"
}
