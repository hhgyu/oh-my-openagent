// The dream child's inputs, gathered by the parent once the run's worktree exists (port of the dream half
// of omo-senpi `worker/spawn-payload.ts` `prepareReflectionSpawn` and `worker/reflection-spawn-input.ts`):
// the worktree's `system/` token estimate, the `compile_warn_tokens` budget and its soft target, the
// skills-usage and memory-usage ledgers and the dream state from the identity runtime directory (an
// absent or unreadable file is `{}`), the worktree structural audit with secret-like strings redacted,
// and the per-identity people policy. Senpi writes each to a file; the V2 child cannot read outside its
// worktree and transcript, so they are returned as the dream task prompt. A ledger over 64 KiB is replaced
// by a truncation note so the prompt stays bounded.

import { auditMemoryRepo, redactSecretLikeMaterial, type ReservedRun } from "@oh-my-opencode/memory-core"
import { estimateSystemTokens } from "@oh-my-opencode/memory-core/commands/tokens"
import { readFile } from "@oh-my-opencode/memory-core/fs"
import { join } from "node:path"
import type { BoundMemorySession } from "./binding"
import { dreamTokenBudget } from "./dream-budget"
import { buildDreamTaskPrompt } from "./dream-persona"

const LEDGER_MAX_BYTES = 64 * 1024

async function readJsonOrEmpty(path: string): Promise<unknown> {
  let raw: string
  try {
    raw = await readFile(path, "utf8")
  } catch {
    return {}
  }
  if (Buffer.byteLength(raw, "utf8") > LEDGER_MAX_BYTES) return { truncated: `ledger exceeds ${LEDGER_MAX_BYTES} bytes; not included` }
  try {
    return JSON.parse(raw)
  } catch {
    return {}
  }
}

function redactStrings(value: unknown): unknown {
  return JSON.parse(JSON.stringify(value, (_key, entry: unknown) => typeof entry === "string" ? redactSecretLikeMaterial(entry) : entry))
}

/** The dream run's first user input for a launch whose worktree is `worktreeDir`. */
export async function buildDreamLaunchPrompt(bound: BoundMemorySession, run: ReservedRun, worktreeDir: string): Promise<string> {
  const { budget, target } = dreamTokenBudget(bound)
  const runtime = bound.paths.runtime
  const people = { ...bound.settings.people, ...bound.settings.agents[bound.identity]?.people }
  const systemTokens = await estimateSystemTokens(worktreeDir)
  const [skillsUsage, memoryUsage, dreamState, audit] = await Promise.all([
    readJsonOrEmpty(join(runtime, "skills-usage.json")),
    readJsonOrEmpty(join(runtime, "memory-usage.json")),
    readJsonOrEmpty(join(runtime, "dream", "state.json")),
    auditMemoryRepo(worktreeDir, { systemTokens, budgetTokens: budget }),
  ])
  return buildDreamTaskPrompt(run.request, {
    systemTokens: { totalTokens: systemTokens.totalTokens, files: systemTokens.files },
    systemTokenBudget: budget,
    systemTokenTarget: target,
    sections: {
      "Skills usage ledger": skillsUsage,
      "Memory usage ledger": memoryUsage,
      "Dream state": dreamState,
      "Structural audit": redactStrings(audit),
      "People policy": { version: 1, people },
    },
  })
}
