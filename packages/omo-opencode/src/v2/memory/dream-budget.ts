// The dream system-token budget, ported from omo-senpi:
// - pressure (`status.ts` `refreshMemoryStatus`): the committed `system/` markdown at HEAD, estimated as
//   floor(bytes / 4), at or above floor(0.8 * compile_warn_tokens) requests a `pressure` dream;
// - the target handed to the dream child (`worker/reflection-spawn-input.ts`): the same soft ratio;
// - the finalization check (`worker/run-finalization-git.ts` `validateIntegratedDreamBudget`): after a dream
//   merged, memory-core `estimateSystemTokens` over the parent repo goes through `validateDreamTokenBudget`.
//   A pressure dream that left the estimate at or above its target keeps its `merged` outcome but records
//   `budget_not_met` (no park failure, as in Senpi); every merged dream records the resulting estimate.

import { GitMemoryRepo, validateDreamTokenBudget, type ReservedRun } from "@oh-my-opencode/memory-core"
import { estimateSystemTokens } from "@oh-my-opencode/memory-core/commands/tokens"
import { existsSync } from "@oh-my-opencode/memory-core/fs"
import { join } from "node:path"
import type { BoundMemorySession } from "./binding"
import type { ReflectionDecision } from "./reflection-failure"

const MEMORY_PRESSURE_SOFT_RATIO = 0.8

/** The configured `compile_warn_tokens` advisory and its soft-pressure target. */
export function dreamTokenBudget(bound: Pick<BoundMemorySession, "settings">): { readonly budget: number; readonly target: number } {
  const budget = bound.settings.compile_warn_tokens
  return { budget, target: Math.floor(MEMORY_PRESSURE_SOFT_RATIO * budget) }
}

/** Senpi's committed `system/` estimate at HEAD; `null` when the memory repo has no commit yet. */
async function committedSystemTokens(repoDir: string, identity: string): Promise<number | null> {
  if (!existsSync(join(repoDir, ".git"))) return null
  const repo = new GitMemoryRepo({ dir: repoDir, agentId: identity })
  const head = await repo.head()
  if (head === null) return null
  const paths = (await repo.lsTree(head)).filter(path => path.startsWith("system/") && path.endsWith(".md"))
  const contents = await Promise.all(paths.map(path => repo.show(head, path)))
  return Math.floor(contents.reduce((sum, content) => sum + Buffer.byteLength(content, "utf8"), 0) / 4)
}

/** True when the committed `system/` tree reached soft pressure (the bind-time `pressure` origin). */
export async function underSystemTokenPressure(bound: Pick<BoundMemorySession, "settings" | "paths" | "identity">): Promise<boolean> {
  const estimate = await committedSystemTokens(bound.paths.repo, bound.identity)
  return estimate !== null && estimate >= dreamTokenBudget(bound).target
}

/** Records the post-merge budget check of a merged dream on its decision; other runs pass through. */
export async function applyDreamTokenBudget(bound: BoundMemorySession, run: ReservedRun, decision: ReflectionDecision): Promise<ReflectionDecision> {
  const origin = run.request.origin
  if (run.request.trigger !== "dream" || origin === undefined || decision.outcome !== "merged") return decision
  const estimate = await estimateSystemTokens(bound.paths.repo)
  const validation = validateDreamTokenBudget({ origin, totalTokens: estimate.totalTokens, targetTokens: dreamTokenBudget(bound).target })
  if (validation.status === "budget_not_met") return { ...decision, reason: "budget_not_met", detail: validation.detail }
  return { ...decision, detail: `Committed system/ estimate is ${validation.totalTokens} tokens; dream target is below ${validation.targetTokens} tokens` }
}
