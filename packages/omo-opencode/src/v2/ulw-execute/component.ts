// OpenCode 2 port of the omo-senpi `ulw-execute-continuation` component, on the continuation logic both now share from
// @oh-my-opencode/boulder-state:
// - Senpi `agent_end` + `agent_settled` -> `experimental.idle` (runs only after successful model work with no pending
//   input). A continuable boulder work this session owns (`opencode:<id>`), with a changed signature and an uncapped
//   budget, admits one hidden steer synthetic whose id derives from that signature.
// - Senpi `input` while streaming -> the `prompt` hook while this session's execution runs: appends the reminder.
// - The ulw-execute skill is registered from its staged Native copy, which records sessions as `opencode:<id>`.
// Senpi also repairs works abandoned by dead sessions on this read; its liveness proof scans Senpi transcripts, which
// OpenCode 2 has none of, so V2 reads without that repair.
import type * as Plugin from "@opencode/plugin/promise/plugin"
import type { Registration } from "@opencode/plugin/promise/registration"
import type { SessionIdle, SessionPrompt } from "@opencode/plugin/promise/session"
import {
  findContinuableWork,
  renderUlwExecuteContinuation,
  ULW_EXECUTE_CONTINUATION_LIMIT,
  ULW_EXECUTE_STEERING_REMINDER,
  ulwExecuteContinuationSignature,
  type ContinuableWork,
} from "@oh-my-opencode/boulder-state"
import { createHash } from "node:crypto"
import { isOwnContinuation, ULW_EXECUTE_CONTINUATION_METADATA_KEY } from "../hooks/continuation-metadata"
import { locateStagedSkillFile, registerStagedSkill } from "../skills/staged-skill"

export type UlwExecuteHost = Pick<Plugin.Context, "session" | "skill" | "location" | "event">

export interface UlwExecuteOptions {
  readonly findWork?: (directory: string, sessionKey: string) => ContinuableWork | null
  /** The staged SKILL.md, by default the copy next to this bundle; `null` registers no skill. */
  readonly skillFile?: string | null
}

export const ulwExecuteSessionKey = (sessionID: string) => `opencode:${sessionID}`

const EXECUTION_EVENTS = [
  "session.execution.started",
  "session.execution.succeeded",
  "session.execution.failed",
  "session.execution.interrupted",
  "session.deleted",
] as const

export async function registerUlwExecuteContinuation(
  host: UlwExecuteHost,
  options: UlwExecuteOptions = {},
): Promise<() => Promise<void>> {
  const directory = host.location.directory
  const findWork = options.findWork ?? ((cwd: string, key: string) => findContinuableWork(cwd, key))
  const sessions = new Map<string, { consecutive: number; lastSignature?: string; running: boolean }>()
  const registrations: Registration[] = []
  const stop = new AbortController()
  const stateOf = (sessionID: string) => {
    let state = sessions.get(sessionID)
    if (!state) sessions.set(sessionID, (state = { consecutive: 0, running: false }))
    return state
  }

  async function onIdle(input: SessionIdle): Promise<void> {
    const state = stateOf(input.sessionID)
    state.running = false
    if (state.consecutive >= ULW_EXECUTE_CONTINUATION_LIMIT) return
    const sessionKey = ulwExecuteSessionKey(input.sessionID)
    const continuable = findWork(directory, sessionKey)
    if (continuable === null) {
      delete state.lastSignature
      return
    }
    const signature = ulwExecuteContinuationSignature(continuable)
    if (state.lastSignature === signature) return
    state.lastSignature = signature
    state.consecutive += 1
    const digest = createHash("sha256").update(`${input.sessionID}\0${state.consecutive}\0${signature}`).digest("hex")
    await host.session.synthetic({
      sessionID: input.sessionID,
      id: `msg_omo_ulwx_${digest.slice(0, 24)}`,
      text: renderUlwExecuteContinuation(directory, continuable, sessionKey),
      delivery: "steer",
      resume: true,
      metadata: { [ULW_EXECUTE_CONTINUATION_METADATA_KEY]: String(state.consecutive) },
    })
  }

  function onPrompt(input: SessionPrompt): void {
    if (isOwnContinuation(input.metadata)) return
    const state = stateOf(input.sessionID)
    state.consecutive = 0
    delete state.lastSignature
    if (!state.running) return
    if (findWork(directory, ulwExecuteSessionKey(input.sessionID)) !== null)
      input.prompt.text = `${input.prompt.text}\n\n${ULW_EXECUTE_STEERING_REMINDER}`
  }

  try {
    const skillFile = options.skillFile === undefined ? locateStagedSkillFile("ulw-execute") : options.skillFile
    const skill = skillFile === null ? undefined : await registerStagedSkill(host.skill, "ulw-execute", skillFile)
    if (skill) registrations.push(skill)
    registrations.push(await host.session.hook("experimental.idle", onIdle))
    registrations.push(await host.session.hook("prompt", onPrompt))
  } catch (error) {
    for (const registration of registrations.reverse()) await registration.dispose().catch(() => {})
    throw error
  }
  const pump = (async () => {
    for await (const event of host.event.subscribe({ types: [...EXECUTION_EVENTS], signal: stop.signal })) {
      if (event.type === "session.deleted") sessions.delete(event.data.sessionID)
      else stateOf(event.data.sessionID).running = event.type === "session.execution.started"
    }
  })().catch((error: unknown) => {
    if (!stop.signal.aborted) console.warn("[oh-my-openagent/v2] ulw-execute execution tracking stopped", String(error))
  })

  return async () => {
    stop.abort()
    await pump
    sessions.clear()
    for (const registration of registrations.reverse()) await registration.dispose()
  }
}
