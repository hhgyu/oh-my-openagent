import type { TeamModeConfig } from "@oh-my-opencode/team-core/config"
import type { TaskRecordStore } from "@oh-my-opencode/senpi-task/manager-kernel"
import { loadRuntimeState } from "@oh-my-opencode/team-core/team-state-store"
import type { ToolDomain } from "@opencode/plugin/effect/tool"
import { Error as ToolError } from "@opencode/plugin/promise/tool"
import { Effect, type Scope } from "effect"
import {
  createTeamMemberSendToolInfo,
  TEAM_MEMBER_SEND_TOOL_NAME,
  type TeamMemberSendCall,
} from "../../tools/team-member-send"
import { createTeamMemberProducer } from "./live-member-producer"

/** Trusted composition only: the original backend child, the approved spec and the approved
 * ManagerStartSpec team identity. Never derived from `spec.memberScopedTools` closures. */
export interface MemberChildInput {
  readonly child: object
  readonly sessionID: string
  readonly agent: string
  /** Approved ManagedStartSpec task id. */
  readonly taskId: string
  /** Approved ManagedStartSpec parent: the team lead session. */
  readonly leadSessionID: string
  /** Approved ManagerStartSpec `team_run_id` / `team_member_name`. */
  readonly team: { readonly runId: string; readonly memberName: string }
  /** Team-core config of the lead's team storage, resolved by the component from trusted roots. */
  readonly config: TeamModeConfig
  /** Original backend observation guard plus component generation fences. */
  readonly assertCurrent: () => void
  readonly appendEvent?: (event: Parameters<TaskRecordStore["appendEvent"]>[1]) => void
}
export interface MemberProducer {
  assertCurrent(): void
  revoke(): void
  join(): Promise<void>
}
export interface TeamMemberOwner {
  /** Actual listed SDK tool ID of the dedicated registration. */
  readonly hostID: string
  /** One producer per original owned member child. */
  bindChild(input: MemberChildInput): MemberProducer
  /** True only while a live producer is bound to this exact session. */
  isBound(sessionID: string): boolean
}
export interface TeamMemberOwnerOptions {
  readonly loadState?: typeof loadRuntimeState
  readonly now?: () => number
  readonly newMessageId?: () => string
}

const FOREIGN_SESSION =
  "The team member send tool is available only to an in-process team member issued by this component"
/** Live team statuses in which a member may still report; deleting/deleted/failed/orphaned refuse. */
const LIVE_TEAM_STATUSES: ReadonlySet<string> = new Set(["creating", "active", "shutdown_requested"])

type Entry = ReturnType<typeof createMemberEntry>

/** Producer over the ORIGINAL member factory for one owned child, fenced by live team-core state. */
function createMemberEntry(
  input: MemberChildInput,
  options: TeamMemberOwnerOptions & { readonly closed: () => boolean },
) {
  const { sessionID, agent, child, leadSessionID } = input
  const { runId, memberName } = input.team
  const config = input.config
  const loadState = options.loadState ?? loadRuntimeState
  const registration = Object.freeze({})
  // Refreshed from team-core state before every send; the original closure reads it at call time.
  let members: readonly string[] = []
  const producer = createTeamMemberProducer({
    native: {
      teamRunId: runId,
      memberName,
      taskId: input.taskId,
      config,
      get members() {
        return members
      },
      appendEvent: (_taskId, event) => {
        try {
          input.appendEvent?.(event)
        } catch {
          // Mail is already durable. Preserve success so an audit failure does not cause a duplicate send.
          console.warn("[oh-my-openagent/v2] team message audit append failed after enqueue", {
            taskId: input.taskId,
            eventType: event.type,
          })
        }
      },
      ...(options.now && { now: options.now }),
      ...(options.newMessageId && { newMessageId: options.newMessageId }),
    },
    assertCurrent() {
      if (options.closed()) throw Error("Team member owner is closing")
    },
  })
  producer.bind({ child, sessionID, agent, registration, assertCurrent: input.assertCurrent })
  const tickets = new Set<Promise<void>>()
  let revoked = false
  const custody = (call: TeamMemberSendCall) => ({ child, sessionID: call.sessionID, agent: call.agent, registration })
  /** Live membership: the team accepts members, its lead is this child's parent and the member is listed. */
  async function assertMembership(): Promise<void> {
    const state = await loadState(runId, config)
    if (state.teamRunId !== runId || !LIVE_TEAM_STATUSES.has(state.status)) throw Error(`Team ${runId} is not active`)
    if (state.leadSessionId !== leadSessionID) throw Error(`Team ${runId} is led by another session`)
    if (!state.members.some((member) => member.name === memberName))
      throw Error(`Member ${memberName} is no longer in team ${runId}`)
    members = state.members.map((member) => member.name)
  }
  return {
    get revoked() {
      return revoked
    },
    assertCurrent(): void {
      if (revoked) throw Error("Member producer revoked")
      input.assertCurrent()
    },
    async send(call: TeamMemberSendCall, sendInput: Parameters<typeof producer.invoke>[2]) {
      // The ticket is owned before any await, so a revoke and join during the membership read waits.
      const { promise: ticket, resolve: settle }: PromiseWithResolvers<void> = Promise.withResolvers()
      tickets.add(ticket)
      try {
        producer.assertCurrent(custody(call))
        await assertMembership()
        return await producer.invoke(custody(call), call.id, sendInput)
      } finally {
        tickets.delete(ticket)
        settle()
      }
    },
    revoke(): void {
      revoked = true
      producer.revoke()
    },
    async join(): Promise<void> {
      revoked = true
      producer.revoke()
      await Promise.allSettled([...tickets])
      await producer.join()
    },
  }
}

/** Acquire the dedicated SDK registration in the original Effect plugin scope. Acquire it BEFORE the
 * owned-child tool guard, so the guard's transform also wraps this tool with its grant check. */
export function acquireTeamMemberOwner(
  domains: { readonly tool: Pick<ToolDomain, "transform" | "list"> },
  options: TeamMemberOwnerOptions = {},
): Effect.Effect<TeamMemberOwner, never, Scope.Scope> {
  return Effect.gen(function* () {
    const entries = new Map<string, Entry>()
    let closed = false
    const info = createTeamMemberSendToolInfo((call, input) => {
      const entry = closed ? undefined : entries.get(call.sessionID)
      if (!entry || entry.revoked) return Promise.reject(new ToolError({ message: FOREIGN_SESSION }))
      return entry.send(call, input)
    })
    yield* domains.tool.transform((editor) => {
      editor.add(info)
    })
    const listed = (yield* domains.tool.list()).filter(
      (tool) => tool.name === TEAM_MEMBER_SEND_TOOL_NAME && tool.options?.namespace === undefined,
    )
    const registered = listed[0]
    if (listed.length !== 1 || !registered?.id)
      return yield* Effect.die(Error("Team member send registration is absent or ambiguous"))
    const hostID = registered.id
    // LIFO: producers are revoked and joined before the SDK registration is removed.
    yield* Effect.addFinalizer(() =>
      Effect.promise(async () => {
        closed = true
        await Promise.allSettled([...entries.values()].map((entry) => entry.join()))
      }),
    )
    const owner: TeamMemberOwner = {
      hostID,
      isBound(sessionID) {
        const entry = entries.get(sessionID)
        return !closed && entry !== undefined && !entry.revoked
      },
      bindChild(input) {
        if (closed) throw Error("Team member owner is closing")
        if (
          !input.child ||
          !input.sessionID ||
          !input.agent ||
          !input.taskId ||
          !input.leadSessionID ||
          !input.team.runId ||
          !input.team.memberName
        )
          throw Error("Incomplete member producer custody")
        if (entries.has(input.sessionID))
          throw Error("Member producer for this child session is still bound or unjoined")
        input.assertCurrent()
        const entry = createMemberEntry(input, { ...options, closed: () => closed })
        entries.set(input.sessionID, entry)
        // Retained until joined, so owner close still joins a revoked producer's in-flight send.
        const forget = () => {
          if (entries.get(input.sessionID) === entry) entries.delete(input.sessionID)
        }
        return Object.freeze({
          assertCurrent: () => entry.assertCurrent(),
          revoke() {
            entry.revoke()
          },
          async join() {
            try {
              await entry.join()
            } finally {
              forget()
            }
          },
        })
      },
    }
    return Object.freeze(owner)
  })
}
