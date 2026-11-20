const REFACTOR = "refactor/SKILL.md"
const DEBUGGING_INVESTIGATE = "debugging/references/methodology/02-investigate.md"

type Replacement = readonly [pattern: RegExp, replacement: string]

const TOOL_RENAMES: readonly Replacement[] = [
  [/\bteam_send_message\b/g, "task_send"],
  [/\bteam_task_create\b/g, "task_create"],
  [/\bteam_task_update\b/g, "task_update"],
  [/\bteamRunId\b/g, "team_run_id"],
  [/\bblockedBy=/g, "blocked_by="],
  [/\bteamName=/g, "team_name="],
  [/\bkind="announcement",\s*/g, ""],
  [/\bbody=/g, "message="],
]

const ARGUMENT_FIXES: Readonly<Record<string, readonly Replacement[]>> = {
  [REFACTOR]: [
    [/task_send\(team_run_id=<id>, (to=\\"lead\\")/g, "task_send($1"],
    [/ \+ task_update\(status=completed\)\./, "; the lead marks the step completed on the team tasklist."],
    [/ \+ task_update\(status=pending\)\./, "; the lead sets the step back to pending on the team tasklist."],
    [
      /\\?`task_update\(status=pending\)\\?`/,
      '`task_update(team_run_id=<id>, task_id=<step task id>, status="pending")`',
    ],
  ],
}

const SHUTDOWN = '`{type: "shutdown_request"}`, then `{type: "shutdown_response", approve: true}`'

const SENTENCES: Readonly<Record<string, readonly Replacement[]>> = {
  [REFACTOR]: [
    [/Call \\?`team_list\\?` and verify no active/, "Confirm from your own `team_create` results that no active"],
    [/a single \\?`team_status\\?` check is acceptable/, "a single `task_output` check on a member is acceptable"],
    [
      /\\?`team_list\\?` to confirm no residual/,
      "Confirm from your `team_create` results and member notifications that there is no residual",
    ],
    [
      /\\?`team_shutdown_request\\?` for each member, then \\?`team_approve_shutdown\\?` if members/,
      `\`task_send\` each member ${SHUTDOWN} if members`,
    ],
  ],
  [DEBUGGING_INVESTIGATE]: [
    [/\\?`team_shutdown_request\\?` (?:→|->) \\?`team_approve_shutdown\\?` (?:→|->)/, `\`task_send\` ${SHUTDOWN} →`],
  ],
}

export const TEAM_TOOL_ADAPTED_FILES: readonly string[] = Object.keys(SENTENCES)

/**
 * OpenCode 2 registers the lead team tools `team_create`, `team_delete`, `task_create`, `task_get`, `task_list` and
 * `task_update`, and sends with `task_send`; it has no `team_send_message`, `team_task_*`, `team_list`, `team_status`
 * or shutdown tools. A drifted anchor throws so the build fails instead of shipping the Native spelling.
 */
export function adaptTeamToolsForV2(file: string, text: string): string {
  const sentences = SENTENCES[file]
  if (sentences === undefined) throw new Error(`${file}: no team-tool adaptation is registered`)
  const adapted = sentences.reduce((current, [pattern, replacement]) => {
    if (!pattern.test(current)) throw new Error(`${file}: team-tool anchor drifted: ${pattern}`)
    return current.replace(pattern, replacement)
  }, text)
  const renamed = TOOL_RENAMES.reduce(
    (current, [pattern, replacement]) => current.replace(pattern, replacement),
    adapted,
  )
  return (ARGUMENT_FIXES[file] ?? []).reduce((current, [pattern, replacement]) => {
    if (!pattern.test(current)) throw new Error(`${file}: team-call argument anchor drifted: ${pattern}`)
    return current.replace(pattern, replacement)
  }, renamed)
}
