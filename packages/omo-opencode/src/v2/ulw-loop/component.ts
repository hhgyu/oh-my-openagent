// OpenCode 2 port of the omo-senpi `ulw-loop` component, on the same shared continuation policy:
// - Senpi `agent_end` + `agent_settled` -> `experimental.idle`, which the host runs only after successful model work
//   with no pending input (never after an interrupt, failure or control-only turn), so Senpi's terminal-outcome gate
//   is the host's own. An active, changed, uncapped loop status admits one hidden steer continuation there, which
//   runs in the same execution; its id is derived from the status it answers, so a repeated edge cannot duplicate it.
// - Senpi `input` while streaming -> the `prompt` hook while this session's execution runs: appends the reminder.
// - Senpi footer status -> the `omo.ulw-loop` RPC the TUI footer reads.
// Loop reads are keyed by the host's own session id, the same scope the eval SDK binds from PI_SESSION_ID.
import type * as Plugin from "@opencode/plugin/promise/plugin"
import type { Registration } from "@opencode/plugin/promise/registration"
import type { SessionIdle, SessionPrompt } from "@opencode/plugin/promise/session"
import { readHostLoopStatus } from "@oh-my-opencode/omo-codex/ulw-loop-session-sdk/host-status"
import {
  createLoopContinuationState,
  ULW_LOOP_CONTINUATION_PROMPT,
  ULW_LOOP_STEERING_REMINDER,
  type ClassifiedLoopStatus,
  type LoopContinuationState,
  type LoopStatus,
} from "@oh-my-opencode/omo-codex/ulw-loop-session-sdk/loop-continuation"
import { createHash } from "node:crypto"
import { locateUlwLoopSkillFile, registerUlwLoopSkill } from "./skill"
import { createUlwLoopStatusRpc } from "./status-rpc"

export type UlwLoopHost = Pick<Plugin.Context, "session" | "tool" | "rpc" | "skill" | "location" | "event">

export interface UlwLoopOptions {
  readonly readStatus?: (cwd: string, sessionID: string) => Promise<ClassifiedLoopStatus>
  /** The staged SKILL.md, by default the copy next to this bundle; `null` registers no skill. */
  readonly skillFile?: string | null
}

const CONTINUATION_METADATA_KEY = "omoUlwLoopContinuation"
const EXECUTION_EVENTS = [
  "session.execution.started",
  "session.execution.succeeded",
  "session.execution.failed",
  "session.execution.interrupted",
  "session.deleted",
] as const
const LOG = "[oh-my-openagent/v2] ulw-loop"

export async function registerUlwLoop(host: UlwLoopHost, options: UlwLoopOptions = {}): Promise<() => Promise<void>> {
  const cwd = host.location.directory
  const readStatus = options.readStatus ?? readHostLoopStatus
  const sessions = new Map<string, { continuation: LoopContinuationState; running: boolean }>()
  const footer = createUlwLoopStatusRpc()
  const registrations: Registration[] = []
  const stop = new AbortController()
  const stateOf = (sessionID: string) => {
    let state = sessions.get(sessionID)
    if (!state) sessions.set(sessionID, (state = { continuation: createLoopContinuationState(), running: false }))
    return state
  }

  async function read(sessionID: string): Promise<LoopStatus | undefined> {
    try {
      const { status, ignored } = await readStatus(cwd, sessionID)
      if (ignored && !(ignored.reason === "non-zero-exit" && ignored.errorCode === "ULW_LOOP_PLAN_MISSING"))
        console.warn(`${LOG} status ignored`, ignored)
      footer.publish(sessionID, status.active)
      return status
    } catch (error) {
      console.warn(`${LOG} status ignored`, { reason: "read-status-failed", error: String(error) })
      return undefined
    }
  }

  async function onIdle(input: SessionIdle): Promise<void> {
    const state = stateOf(input.sessionID)
    state.running = false
    if (state.continuation.capReached()) return
    const status = await read(input.sessionID)
    if (status === undefined) return
    const decision = state.continuation.decide(status)
    if (!decision.continue) return
    const digest = createHash("sha256").update(`${input.sessionID}\0${decision.count}\0${status.raw}`).digest("hex")
    await host.session.synthetic({
      sessionID: input.sessionID,
      id: `msg_omo_ulw_${digest.slice(0, 24)}`,
      text: ULW_LOOP_CONTINUATION_PROMPT,
      delivery: "steer",
      resume: true,
      metadata: { [CONTINUATION_METADATA_KEY]: String(decision.count) },
    })
  }

  async function onPrompt(input: SessionPrompt): Promise<void> {
    if (input.metadata?.[CONTINUATION_METADATA_KEY] !== undefined) return
    const state = stateOf(input.sessionID)
    state.continuation.reset()
    if (!state.running) return
    const status = await read(input.sessionID)
    if (status?.active) input.prompt.text = `${input.prompt.text}\n\n${ULW_LOOP_STEERING_REMINDER}`
  }

  async function trackExecutions(): Promise<void> {
    for await (const event of host.event.subscribe({ types: [...EXECUTION_EVENTS], signal: stop.signal })) {
      if (event.type === "session.deleted") {
        sessions.delete(event.data.sessionID)
        footer.forget(event.data.sessionID)
      } else stateOf(event.data.sessionID).running = event.type === "session.execution.started"
    }
  }

  try {
    const skillFile = options.skillFile === undefined ? locateUlwLoopSkillFile() : options.skillFile
    const skill = skillFile === null ? undefined : await registerUlwLoopSkill(host.skill, skillFile)
    if (skill) registrations.push(skill)
    registrations.push(await footer.register(host.rpc))
    registrations.push(await host.session.hook("experimental.idle", onIdle))
    registrations.push(await host.session.hook("prompt", onPrompt))
    registrations.push(
      await host.tool.hook("execute.after", async (input) => {
        if (input.tool === "eval") await read(input.sessionID)
      }),
    )
  } catch (error) {
    for (const registration of registrations.reverse()) await registration.dispose().catch(() => {})
    throw error
  }
  const pump = trackExecutions().catch((error: unknown) => {
    if (!stop.signal.aborted) console.warn(`${LOG} execution tracking stopped`, String(error))
  })

  return async () => {
    stop.abort()
    await pump
    footer.close()
    sessions.clear()
    for (const registration of registrations.reverse()) await registration.dispose()
  }
}
