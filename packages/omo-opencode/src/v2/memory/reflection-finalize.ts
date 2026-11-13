// Parent-side finalization of one settled reflection child (port of omo-senpi
// `worker/run-finalization-git.ts` `resolveFinalizationDecision`, without Senpi's durable ledger
// checkpoints: the V2 child is in-process, so a crash between these steps is recovered by discarding
// the worktree and failing the reservation, never by resuming a half-finalized run).
// - a child that failed, hit its deadline or was cancelled maps to failed / timed_out, nothing merges;
// - a completed child's tip goes through memory-core `preflightReflectionDescriptions` and
//   `validateCompletion` against the worktree's recorded base, which also lands the gate's link repair
//   (links to removed notes repointed, recognised only by recomputing it, #12642); a dream with a target
//   document fails with `invalid_target` when it changed anything else, the gate's own repairs aside
//   (`pathsOutsideTarget`, as Senpi's `resolveFinalizationDecision`);
// - a valid tip is merged with `integrateValidatedReflection` in `auto` mode under the memory writer lock
//   (`integration` mode expects the child to have merged by itself, which a V2 child without git cannot);
// - the worktree and its branch are always removed afterwards (`cleanupReflectionWorktree`); a leftover
//   is only reported, and the reflection orphan sweep reclaims it later, as in Senpi.

import {
  cleanupReflectionWorktree,
  describeDroppedEntries,
  integrateValidatedReflection,
  pathsOutsideTarget,
  preflightReflectionDescriptions,
  validateCompletion,
  type ReflectionWorktree,
  type ReservedRun,
} from "@oh-my-opencode/memory-core"
import type { ReflectionChildResult } from "./reflection-child"
import type { ReflectionDecision } from "./reflection-failure"
import type { WriterLock } from "./reflection-run-store"

type Warn = (message: string, details?: Record<string, unknown>) => void

export async function decideReflection(input: {
  readonly run: ReservedRun
  readonly worktree: ReflectionWorktree
  readonly child: ReflectionChildResult
  readonly withWriterLock: WriterLock
  readonly warn: Warn
}): Promise<ReflectionDecision> {
  const { child, worktree, run } = input
  if (child.status === "deadline") return { outcome: "timed_out", reason: "deadline_exceeded", detail: child.detail }
  if (child.status === "failed") return { outcome: "failed", reason: "child_exit", detail: child.detail }
  if (child.status === "cancelled")
    return { outcome: "failed", reason: "cancelled", detail: "the reflection child was cancelled before it settled" }
  await preflightReflectionDescriptions(worktree, worktree.baseSha, worktree.exec, (message, fields) => {
    input.warn(message, { ...fields })
  })
  const validation = await validateCompletion(worktree, worktree.baseSha, worktree.exec)
  const droppedNote =
    validation.status === "valid" || validation.status === "no_changes"
      ? validation.dropped?.length
        ? describeDroppedEntries(validation.dropped)
        : undefined
      : undefined
  if (validation.status === "no_changes")
    return { outcome: "no_changes", ...(droppedNote === undefined ? {} : { detail: droppedNote }) }
  if (validation.status !== "valid")
    return { outcome: validation.status, reason: "completion_validation", detail: validation.detail }
  const target = run.request.targetDoc
  if (target !== undefined && pathsOutsideTarget(validation, [target]).length > 0) {
    return { outcome: "failed", reason: "invalid_target", detail: "Dream changed paths outside targetDoc" }
  }
  const integrated = await integrateValidatedReflection(worktree, {
    mode: "auto",
    runId: run.runId,
    summary: `${run.request.trigger} ${run.runId}`,
    validated: { tipSha: validation.tipSha, changedPaths: validation.changedPaths },
    withWriterLock: input.withWriterLock,
  })
  const detail = [integrated.detail, droppedNote].filter(Boolean).join("; ")
  return {
    outcome: integrated.outcome,
    ...(detail === "" ? {} : { detail }),
    ...(integrated.integrationSha === undefined ? {} : { integrationSha: integrated.integrationSha }),
  }
}

/** Removes the run's worktree and branch; a leftover is reported, never thrown (the orphan sweep reclaims it). */
export async function cleanupRunWorktree(worktree: ReflectionWorktree, runId: string, warn: Warn): Promise<boolean> {
  try {
    const cleanup = await cleanupReflectionWorktree(worktree)
    if (cleanup.worktreeRemoved && cleanup.branchRemoved) return true
    warn("reflection worktree cleanup incomplete; the orphan sweep reclaims it", { runId, ...cleanup })
  } catch (error) {
    warn("reflection worktree cleanup failed; the orphan sweep reclaims it", {
      runId,
      error: error instanceof Error ? error.message : String(error),
    })
  }
  return false
}
