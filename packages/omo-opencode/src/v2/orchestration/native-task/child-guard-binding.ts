import type { ManagedStartSpec } from "@oh-my-opencode/senpi-task/manager-kernel"
import type { ChildGuardBinding, OwnedChildToolGuard } from "../../host/owned-child-tool-guard"
import type { ChildHandle } from "../../host/session-backend"
import type { HostGrantRequirement, PreparedHostTaskGrant } from "./host-grant"
import type { TeamModeConfig } from "@oh-my-opencode/team-core/config"
import type { TeamMemberOwner } from "./live-member-owner"
import type { ReadonlyBrokerOwner } from "./live-readonly-producer"
import type { CodemodeReadonlyOwner } from "./live-codemode-readonly"
import { CODEMODE_READONLY_NATIVE_NAME } from "../../tools/codemode-readonly"

export interface NativeChildGuardBindingOptions {
  readonly assertGeneration: () => void
  /** Live dedicated broker registration. Absent: a curated selection stays unbound and is refused. */
  readonly readonly?: ReadonlyBrokerOwner
  /** Live dedicated team member send registration and the trusted team-core config resolver of a
   * lead's team storage. Absent: a member selection stays unbound and is refused. */
  readonly member?: {
    readonly owner: TeamMemberOwner
    readonly teamConfigFor: (leadSessionID: string) => TeamModeConfig
    /** Team mail delivery for a freshly bound member; returns its release, run when the producer goes. */
    readonly onBound?: (member: { readonly leadSessionID: string; readonly teamRunId: string; readonly memberName: string; readonly sessionID: string }) => () => void
  }
  /** Live dedicated CodeMode `ls` counterpart registration. Absent: a granted `ls` call is refused. */
  readonly codemodeReadonly?: CodemodeReadonlyOwner
  /** The SAME owned-child guard the runner binds every child into. Its `webfetch` hook refuses every
   * CodeMode `fetch` of a bound child that has no live network producer, and none is bound here, so
   * with it `codemode-network-guard` is claimed as a deny-all guard. Absent: the requirement stays
   * unbound and a CodeMode selection is refused. */
  readonly network?: { readonly guard: OwnedChildToolGuard }
}
/** Trusted runtime DATA from the ORIGINAL approved ManagerStartSpec, never from member tool closures. */
export interface NativeChildGuardOrigin {
  readonly team?: { readonly runId: string; readonly memberName: string }
}
type Coverage = NonNullable<ChildGuardBinding["coverage"]>
type Target = NonNullable<Coverage["targets"]>[number]
type Producer = { assertCurrent(): void; revoke(): void; join(): Promise<void> }

/** The only member slot ported so far; workpool and other member tools stay unbound. */
const MEMBER_SEND_NATIVE_NAME = "task_send"

function targetsFor(selection: PreparedHostTaskGrant, requirement: HostGrantRequirement, hostID: string): Target[] {
  return selection.bindingSlots.filter(slot => slot.requirement === requirement).map(slot => ({ requirement, nativeName: slot.nativeName, hostID }))
}

/** Revoke all, then join all; every join settles before the first failure is rethrown. */
function combine(producers: readonly Producer[]): { revoke(): void; join(): Promise<void> } {
  return {
    revoke() { for (const producer of producers) producer.revoke() },
    async join() {
      for (const producer of producers) producer.revoke()
      const failed = (await Promise.allSettled(producers.map(producer => producer.join()))).find(result => result.status === "rejected")
      if (failed) throw failed.reason
    },
  }
}

/** Trusted component binder for the runtime `childGuardBinding` seam. Only producers that are
 * actually installed are claimed as bound; kernel requirements and member slots other than
 * `task_send` stay unbound, so a selection needing them is refused by the runner as incomplete,
 * never silently widened. The network requirement is claimed only as the guard's deny-all fetch. */
export function createNativeChildGuardBinding(options: NativeChildGuardBindingOptions) {
  const { assertGeneration } = options
  return function childGuardBinding(spec: ManagedStartSpec, approved: { readonly buildAgentID: string; readonly selection: PreparedHostTaskGrant }, origin: NativeChildGuardOrigin = {}) {
    const { selection } = approved
    const broker = selection.requirements.includes("curated-readonly-broker") ? options.readonly : undefined
    const memberSlots = selection.bindingSlots.filter(slot => slot.requirement === "member-live-bindings")
    const team = origin.team
    const member = selection.requirements.includes("member-live-bindings") && team && memberSlots.length > 0
      && memberSlots.every(slot => slot.nativeName === MEMBER_SEND_NATIVE_NAME) ? options.member : undefined
    // The CodeMode `ls` counterpart is a selected custom catalog grant, so it needs a producer, not a slot.
    const owner = options.codemodeReadonly
    const listing = owner && selection.selected.some(pair => pair.nativeName === CODEMODE_READONLY_NATIVE_NAME && pair.hostID === owner.hostID) ? owner : undefined
    const bound: HostGrantRequirement[] = [], targets: Target[] = []
    if (broker) { bound.push("curated-readonly-broker"); targets.push(...targetsFor(selection, "curated-readonly-broker", broker.hostID)) }
    if (member) { bound.push("member-live-bindings"); targets.push(...targetsFor(selection, "member-live-bindings", member.owner.hostID)) }
    if (options.network && selection.requirements.includes("codemode-network-guard")) bound.push("codemode-network-guard")
    const coverage: Coverage = bound.length ? { boundRequirements: bound, targets } : { boundRequirements: [] }
    return { coverage, assertCurrent: assertGeneration, bind(child: ChildHandle, assertBackendCurrent: () => void): ChildGuardBinding {
      const current = () => { assertGeneration(); assertBackendCurrent() }
      if (!broker && !member && !listing) return { child, agent: approved.buildAgentID, coverage, assertCurrent: current }
      const sessionID = child.locator.sessionID
      const producers: Producer[] = []
      try {
        if (broker) producers.push(broker.bindChild({ child, sessionID, agent: approved.buildAgentID, cwd: spec.cwd, assertCurrent: current }))
        if (listing) producers.push(listing.bindChild({ child, sessionID, agent: approved.buildAgentID, cwd: spec.cwd, assertCurrent: current }))
        if (member && team) {
          producers.push(member.owner.bindChild({ child, sessionID, agent: approved.buildAgentID, taskId: spec.taskId,
            leadSessionID: spec.parentSessionId, team, config: member.teamConfigFor(spec.parentSessionId), assertCurrent: current }))
          const release = member.onBound?.({ leadSessionID: spec.parentSessionId, teamRunId: team.runId, memberName: team.memberName, sessionID })
          if (release) producers.push({ assertCurrent() {}, revoke: release, async join() { release() } })
        }
      } catch (error) {
        // A partial bind never leaves a live producer behind; the owners still join it at close.
        for (const producer of producers) producer.revoke()
        throw error
      }
      return { child, agent: approved.buildAgentID, coverage,
        assertCurrent() { current(); for (const producer of producers) producer.assertCurrent() },
        producers: combine(producers) }
    } }
  }
}
