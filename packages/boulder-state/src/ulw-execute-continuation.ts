import { join } from "node:path"

import { getPlanChecklist } from "./plan-checklist"
import { getWorkForSession, reconcileStaleWorks, resolveBoulderPlanPathForWork } from "./storage"
import type { BoulderWorkState, PlanChecklist, ReconcileStaleWorksOptions } from "./types"

// The ulw-execute continuation every host runs: which boulder work a session may continue, the dedupe signature, the
// cap, and the directive. `sessionKey` is the platform-prefixed id the work records (`senpi:<id>`, `opencode:<id>`).

export const ULW_EXECUTE_CONTINUATION_LIMIT = 8

export const ULW_EXECUTE_STEERING_REMINDER = [
  "<omo-senpi-ulw-execute>",
  "An active ulw-execute work plan is present in this working directory.",
  "Before continuing, read `.omo/boulder.json` and the active plan file to determine what remains; use the ledger and plan as the source of truth.",
  "Continue the current work with evidence-bound execution; do not start unrelated work until every top-level checkbox is `- [x]`.",
  "</omo-senpi-ulw-execute>",
].join("\n")

export interface ContinuableWork {
  readonly work: BoulderWorkState
  readonly planPath: string
  readonly checklist: PlanChecklist
}

export interface FindContinuableWorkOptions {
  /** Repairs works abandoned by a dead session before the read (#8413); omitted, nothing is reconciled. */
  readonly reconcile?: ReconcileStaleWorksOptions
}

export function findContinuableWork(
  directory: string,
  sessionKey: string,
  options: FindContinuableWorkOptions = {},
): ContinuableWork | null {
  if (options.reconcile !== undefined) reconcileStaleWorks(directory, options.reconcile)
  const work = getWorkForSession(directory, sessionKey)
  if (!work) return null
  if (work.status !== "active" && work.status !== "paused") return null
  const planPath = resolveBoulderPlanPathForWork(directory, work)
  const checklist = getPlanChecklist(planPath)
  if (checklist.total <= 0) return null
  return { work, planPath, checklist }
}

export function ulwExecuteContinuationSignature({ work, checklist }: ContinuableWork): string {
  return `${work.work_id}:${work.updated_at ?? work.started_at}:${checklist.completed}/${checklist.total}`
}

export function renderUlwExecuteContinuation(
  directory: string,
  { work, planPath, checklist }: ContinuableWork,
  sessionKey: string,
): string {
  const worktreePath = work.worktree_path ?? null
  const worktreeBlock =
    worktreePath === null
      ? ""
      : `\n- Worktree: \`${worktreePath}\` (all edits, tests, and commands run inside this directory)`
  const nextLabel = checklist.nextTaskLabel ?? "none (final gate pending)"
  const finalGateHint =
    checklist.remaining === 0
      ? "\nAll top-level checkboxes are complete. Run the Final Verification Wave and mark the boulder work completed."
      : ""

  return [
    "<omo-senpi-ulw-execute-continuation>",
    "You are mid-flight on a ulw-execute work plan; this turn is an automatic continuation. Do NOT ask whether to continue: the contract is auto-continue until every top-level checkbox is `- [x]`.",
    "",
    "# State",
    "",
    `- Plan: \`${work.plan_name}\``,
    `- Plan file: \`${planPath}\``,
    `- Boulder state: \`${join(directory, ".omo", "boulder.json")}\``,
    `- Remaining top-level checkboxes: ${checklist.remaining} of ${checklist.total}`,
    `- [Status: ${checklist.completed}/${checklist.total}, next: ${nextLabel}]`,
    `- Ledger: \`${join(directory, ".omo", "ulw-execute", "ledger.jsonl")}\``,
    `- Your session id in boulder.json: ${sessionKey}`,
    `${worktreeBlock}`,
    "",
    "# What to do this turn",
    "",
    "1. Read the plan file AND the ledger first: they are the only sources of truth for what remains and what evidence exists; do not trust your memory of prior turns.",
    `2. When the remaining count is \`0\`, skip checkbox execution and perform the Final gate now. Otherwise, pick the FIRST unchecked top-level checkbox in \`## TODOs\` or \`## Final Verification Wave\`.${finalGateHint}`,
    "3. Apply the checkbox's tier and verify with real-surface evidence. Decompose and dispatch sub-tasks in parallel via Senpi's `task` tool when safe.",
    "4. Honor the delivery mode recorded in the goal/ledger at session start: `--make-pr` finishes through the task-owned worktree and an opened PR, then hands off with the PR URL; `--ship` keeps working until that PR is MERGED, then removes the worktree and syncs `.omo/` state back.",
    "5. After verification, apply the checkbox, append a durable evidence record to the ledger, and continue.",
    "</omo-senpi-ulw-execute-continuation>",
  ].join("\n")
}
