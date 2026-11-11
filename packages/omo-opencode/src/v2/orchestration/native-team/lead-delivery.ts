import { createHash } from "node:crypto"
import type { TeamModeConfig } from "@oh-my-opencode/team-core/config"
import { loadRuntimeState } from "@oh-my-opencode/team-core/team-state-store"
import { TEAM_LEAD_SENTINEL, createLeadPoller, createMemberSelfPoller, type LeadInjection, type LeadPoller, type MemberSelfPoller } from "@oh-my-opencode/senpi-task/team-operations"
import { openTeamDeliveryJournal, type TeamDeliveryJournal } from "../../host/team-delivery-journal"

/** The two public session calls a delivery needs, projected from the joined session API. */
export interface TeamDeliverySession {
  get(input: { sessionID: string }, options?: { signal?: AbortSignal }): Promise<{ readonly id: string; readonly location: { readonly directory: string } }>
  synthetic(input: { sessionID: string; id: string; text: string; delivery: "steer"; resume: boolean; metadata: { readonly [key: string]: string } },
    options?: { signal?: AbortSignal }): Promise<{ readonly id: string; readonly sessionID: string; readonly type: string; readonly payload: { readonly text: string } }>
}
export interface LeadDeliveryOptions {
  readonly session: TeamDeliverySession
  readonly directory: string
  /** Throws once the component generation is retired. */
  readonly assertGeneration: () => void
  /** Trusted team-core config of a lead's team storage. */
  readonly teamConfigFor: (leadSessionID: string) => TeamModeConfig
  /** Trusted private journal path in the lead's own Native state directory. */
  readonly journalPathFor: (leadSessionID: string) => string
  /** The S5b member producer: true only while a live producer is bound to this exact session. */
  readonly isMemberBound: (sessionID: string) => boolean
  readonly loadState?: typeof loadRuntimeState
  /** Background tick period; 0 disables the timer (deliveries then run only on `refresh`). */
  readonly pollIntervalMs?: number
  readonly onError?: (error: unknown) => void
}
export interface BoundMember { readonly leadSessionID: string; readonly teamRunId: string; readonly memberName: string; readonly sessionID: string }
export interface LeadDeliveryOwner {
  /** A bound in-process member: starts its member poller and its team's lead poller. Returns the release. */
  memberBound(member: BoundMember): () => void
  /** Runs one serialized delivery pass for a team now: re-gates it, delivers due mail, settles. */
  refresh(teamRunId: string): Promise<void>
  close(): Promise<void>
}

/** Team statuses in which mail is delivered. `creating` waits (members bind before the team turns
 * active); deleting/deleted/failed/orphaned, a missing state or another lead stop the team's pollers. */
const DELIVERABLE: ReadonlySet<string> = new Set(["active", "shutdown_requested"])
const DROPPED: ReadonlySet<string> = new Set(["deleted"])
/** A sender filter no message carries: the poll only settles reservations and processes no mail. */
const SETTLE_ONLY = { from: "\u0000" }
const LEAD_KEY_PREFIX = "team-message:"

/** Deterministic host message id of one delivery; every retry posts the SAME id and the host dedups it. */
export function teamDeliveryInputId(teamRunId: string, recipient: string, messageId: string): string {
  return "msg_omo_team_" + createHash("sha256").update(`team:${teamRunId}:${recipient}:${messageId}`).digest("hex").slice(0, 40)
}

type Member = { readonly sessionID: string; readonly poller: MemberSelfPoller; recovered: boolean; stopped: boolean }
type Team = { readonly runId: string; readonly lead: string; readonly config: TeamModeConfig; readonly poller: LeadPoller
  readonly members: Map<string, Member>; readonly inflight: Set<Promise<void>>; chain: Promise<void>; stopped: boolean; unsettled: boolean }
type Target = { readonly recipient: string; readonly receiver: string; readonly member?: Member }
type Gate = { readonly kind: "live"; readonly members: readonly string[]; readonly lead: string } | { readonly kind: "wait" } | { readonly kind: "gone"; readonly drop: boolean }

function isMissing(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT"
}

/** Component-owned delivery of team mail into the receiving sessions.
 * AUTHORITY: these are asynchronous NOTIFICATIONS of mail a lead or member already sent under its own
 * call authority, never new initiations, so no call token is stored or replayed. Before EVERY delivery
 * the owner re-checks: the component generation is current; the team is deliverable in team-core and
 * led by the lead it was bound under; for lead mail the receiver IS that lead; `session.get(receiver)`
 * succeeds in this directory; for member mail the S5b producer is still bound. A failed check calls no
 * synthetic, so the poller releases the reservation and the mail stays unread for a later pass.
 * TURNS: Native delivers team mail with `{ deliverAs: "steer", triggerTurn: true }`. The OpenCode 2
 * mapping is `delivery: "steer", resume: true`: a busy receiver sees it on its next model step, an idle
 * one starts a turn. Members receive mail only while bound (resident), so a finished or released member
 * never gets a stray turn; its mail waits unread. Re-posting an accepted id starts no turn (S5d probe). */
export function createLeadDeliveryOwner(options: LeadDeliveryOptions): LeadDeliveryOwner {
  const teams = new Map<string, Team>(), journals = new Map<string, TeamDeliveryJournal>()
  // Teams stopped while their run still existed (e.g. `deleting`): their journal rows wait until a
  // later refresh sees the run gone, so a delete's final refresh still drops them.
  const retired = new Map<string, Team>()
  const transportStop = new AbortController(), loadState = options.loadState ?? loadRuntimeState
  const note = (error: unknown) => { options.onError?.(error) }
  let closed = false
  function journalFor(lead: string): TeamDeliveryJournal {
    let journal = journals.get(lead)
    if (!journal) {
      journal = openTeamDeliveryJournal({ path: options.journalPathFor(lead),
        namespace: "opencode2-team:" + createHash("sha256").update(JSON.stringify([options.directory, lead])).digest("hex") })
      journals.set(lead, journal)
    }
    return journal
  }
  /** Live team-core gate of a team: deliverable, not yet (creating or an unreadable state), or gone. */
  async function gate(team: Team): Promise<Gate> {
    try {
      const state = await loadState(team.runId, team.config)
      if (state.teamRunId !== team.runId || state.leadSessionId !== team.lead) return { kind: "gone", drop: false }
      if (DELIVERABLE.has(state.status)) return { kind: "live", members: state.members.map(member => member.name), lead: state.leadSessionId }
      return state.status === "creating" ? { kind: "wait" } : { kind: "gone", drop: DROPPED.has(state.status) }
    } catch (error) {
      if (isMissing(error)) return { kind: "gone", drop: true }
      note(error)
      return { kind: "wait" }
    }
  }
  async function authorized(team: Team, target: Target): Promise<boolean> {
    try {
      options.assertGeneration()
      if (closed || team.stopped || target.member?.stopped) return false
      const state = await gate(team)
      if (state.kind !== "live") return false
      if (target.member ? !state.members.includes(target.recipient) || !options.isMemberBound(target.receiver) : target.receiver !== state.lead) return false
      const actual = await options.session.get({ sessionID: target.receiver }, { signal: transportStop.signal })
      options.assertGeneration()
      return actual.id === target.receiver && actual.location.directory === options.directory
    } catch (error) { note(error); return false }
  }
  async function deliver(team: Team, target: Target, messageId: string, text: string | undefined): Promise<void> {
    const journal = journalFor(team.lead), key = { teamRunId: team.runId, recipient: target.recipient, messageId }
    if (text === undefined || journal.isAcked(key) || !await authorized(team, target)) return
    const inputID = teamDeliveryInputId(team.runId, target.recipient, messageId)
    const intent = journal.recordIntent(key, target.receiver, inputID)
    // Last same-stack fence before transport.
    options.assertGeneration()
    if (closed || team.stopped || target.member && (target.member.stopped || !options.isMemberBound(target.receiver))) return
    const result = await options.session.synthetic({ sessionID: target.receiver, id: inputID, text, delivery: "steer", resume: true,
      metadata: { omoTeamRunId: team.runId, omoTeamRecipient: target.recipient, omoTeamMessageId: messageId } }, { signal: transportStop.signal })
    if (result.id !== inputID || result.sessionID !== target.receiver || result.type !== "synthetic" || result.payload.text !== text) throw Error("Foreign team delivery ACK")
    journal.markAcked(intent, { id: result.id, sessionID: result.sessionID })
  }
  function own(team: Team, work: Promise<void>): Promise<void> {
    const tracked = work.catch(note)
    team.inflight.add(tracked)
    void tracked.finally(() => team.inflight.delete(tracked))
    return tracked
  }
  function createTeam(runId: string, lead: string): Team {
    const config = options.teamConfigFor(lead)
    const isDelivered = (recipient: string) => (messageId: string) => journalFor(lead).isAcked({ teamRunId: runId, recipient, messageId })
    const team: Team = { runId, lead, config, members: new Map(), inflight: new Set(), chain: Promise.resolve(), stopped: false, unsettled: false,
      poller: createLeadPoller({ teamRunId: runId, config, eventTaskId: () => undefined, isDelivered: isDelivered(TEAM_LEAD_SENTINEL),
        coordinator: { enqueue(injection: LeadInjection) {
          if (!injection.key.startsWith(LEAD_KEY_PREFIX)) throw Error("Unexpected lead team injection")
          const messageId = injection.key.slice(LEAD_KEY_PREFIX.length)
          // onFlushed fires whether or not the host accepted it; the settle poll then commits or releases.
          team.unsettled = true
          void own(team, deliver(team, { recipient: TEAM_LEAD_SENTINEL, receiver: lead }, messageId, injection.content).finally(() => injection.onFlushed?.()))
        } } }) }
    return team
  }
  function bindMember(team: Team, member: BoundMember): Member {
    let staged: string | undefined
    const entry: Member = { sessionID: member.sessionID, recovered: false, stopped: false, poller: createMemberSelfPoller({
      teamRunId: team.runId, memberName: member.memberName, config: team.config, sessionDir: "",
      isDelivered: messageId => journalFor(team.lead).isAcked({ teamRunId: team.runId, recipient: member.memberName, messageId }),
      inject(content) { staged = content },
      // Awaited by the member poller under its inbox lease; it then commits or releases at once.
      afterInject(message) {
        const text = staged
        staged = undefined
        return own(team, deliver(team, { recipient: member.memberName, receiver: member.sessionID, member: entry }, message.messageId, text))
      },
    }) }
    return entry
  }
  function stopTeam(team: Team): void {
    team.stopped = true
    team.poller.shutdown()
    for (const member of team.members.values()) { member.stopped = true; member.poller.shutdown() }
    if (teams.get(team.runId) === team) teams.delete(team.runId)
  }
  async function pass(team: Team): Promise<void> {
    if (closed || team.stopped) return
    try { options.assertGeneration() } catch (error) { note(error); return }
    const state = await gate(team)
    if (state.kind === "wait") return
    if (state.kind === "gone") {
      stopTeam(team)
      if (state.drop) drop(team)
      else retired.set(team.runId, team)
      return
    }
    await team.poller.pollOnce()
    if (team.unsettled) { team.unsettled = false; await Promise.allSettled([...team.inflight]); await team.poller.pollOnce(SETTLE_ONLY) }
    for (const [name, member] of team.members) {
      if (member.stopped || !options.isMemberBound(member.sessionID)) { member.stopped = true; member.poller.shutdown(); team.members.delete(name); continue }
      if (!member.recovered) { await member.poller.recoverReservations(); member.recovered = true }
      await member.poller.pollOnce()
    }
  }
  /** Forgets a gone run: acked rows and unacked intents alike. Its pollers are already stopped and
   * every delivery re-gates on a live team first, so a dropped intent is never posted. */
  function drop(team: Team): void {
    if (retired.get(team.runId) === team) retired.delete(team.runId)
    try { journalFor(team.lead).dropTeam(team.runId) } catch (error) { note(error) }
  }
  /** A retired run is re-gated: dropped once gone (deleted or its state removed), kept while deleting. */
  async function sweep(team: Team): Promise<void> {
    if (closed || retired.get(team.runId) !== team) return
    const state = await gate(team)
    if (state.kind === "gone" && state.drop) drop(team)
  }
  function refresh(teamRunId: string): Promise<void> {
    const team = teams.get(teamRunId)
    if (!team) {
      const stopped = retired.get(teamRunId)
      if (!stopped) return Promise.resolve()
      stopped.chain = stopped.chain.then(() => sweep(stopped)).catch(note)
      return stopped.chain
    }
    team.chain = team.chain.then(() => pass(team)).catch(note)
    return team.chain
  }
  const interval = options.pollIntervalMs ?? 1000
  const timer = interval > 0 ? setInterval(() => { for (const runId of new Set([...teams.keys(), ...retired.keys()])) void refresh(runId) }, interval) : undefined
  timer?.unref?.()
  return {
    memberBound(member) {
      if (closed) throw Error("Team delivery owner is closed")
      let team = teams.get(member.teamRunId)
      if (team && team.lead !== member.leadSessionID) throw Error("Team delivery is bound to another lead")
      if (!team) { retired.delete(member.teamRunId); team = createTeam(member.teamRunId, member.leadSessionID); teams.set(member.teamRunId, team) }
      const owner = team
      owner.members.get(member.memberName)?.poller.shutdown()
      const entry = bindMember(owner, member)
      owner.members.set(member.memberName, entry)
      void refresh(owner.runId)
      return () => { entry.stopped = true; entry.poller.shutdown(); if (owner.members.get(member.memberName) === entry) owner.members.delete(member.memberName) }
    },
    refresh,
    async close() {
      if (closed) return
      closed = true
      if (timer) clearInterval(timer)
      transportStop.abort(Error("Team delivery owner closed"))
      const all = [...teams.values(), ...retired.values()]
      for (const team of all) stopTeam(team)
      await Promise.allSettled(all.flatMap(team => [team.chain, ...team.inflight]))
      for (const journal of journals.values()) journal.close()
      journals.clear()
    },
  }
}
