import type { ManagedStartSpec } from "@oh-my-opencode/senpi-task/manager-kernel"
import type { ChildGuardBinding, OwnedChildToolGuard } from "../../host/owned-child-tool-guard"
import type { ChildHandle } from "../../host/session-backend"
import type { HostGrantRequirement, PreparedHostTaskGrant } from "./host-grant"
import type { TeamModeConfig } from "@oh-my-opencode/team-core/config"
import type { TeamMemberOwner } from "./live-member-owner"
import type { ReadonlyBrokerOwner } from "./live-readonly-producer"
import type { CodemodeReadonlyOwner } from "./live-codemode-readonly"
import type { KernelToolOwner } from "./kernel-binding"
import { CODEMODE_READONLY_NATIVE_NAME } from "../../tools/codemode-readonly"
import { webfetchNetworkFor } from "./child-guard-binding-network"

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
  /** Live dedicated `omo_kernel_tool` registration. With it, a spec carrying a parent kernel-tool grant
   * (from an eval cell's `tools.task`) is bound to its child. Absent: such a selection is refused. */
  readonly kernel?: KernelToolOwner
  /** The SAME owned-child guard the runner binds every child into. Its `webfetch` hook refuses every
   * CodeMode `fetch` of a bound child without a network binding; a child whose selection includes
   * Native `webfetch` is bound for GET under Native's URL rules, any other child stays deny-all. With
   * it `codemode-network-guard` is claimed. Absent: the requirement stays unbound and a CodeMode
   * selection is refused. */
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
 * actually installed are claimed as bound; member slots other than `task_send`, and a kernel
 * requirement without the kernel owner or without the approved grant, stay unbound, so a selection
 * needing them is refused by the runner as incomplete, never silently widened. The network
 * requirement is claimed by the guard: GET only with `webfetch`. */
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
    // The grant is read from the approved spec only; its descriptors are the slots host-grant derived.
    const grant = spec.kernelTools
    const kernel = selection.requirements.includes("kernel-live-bindings") && grant && grant.descriptors.length > 0 ? options.kernel : undefined
    const bound: HostGrantRequirement[] = [], targets: Target[] = []
    if (broker) { bound.push("curated-readonly-broker"); targets.push(...targetsFor(selection, "curated-readonly-broker", broker.hostID)) }
    if (member) { bound.push("member-live-bindings"); targets.push(...targetsFor(selection, "member-live-bindings", member.owner.hostID)) }
    if (kernel) { bound.push("kernel-live-bindings"); targets.push(...targetsFor(selection, "kernel-live-bindings", kernel.hostID)) }
    if (options.network && selection.requirements.includes("codemode-network-guard")) bound.push("codemode-network-guard")
    const coverage: Coverage = bound.length ? { boundRequirements: bound, targets } : { boundRequirements: [] }
    return { coverage, assertCurrent: assertGeneration, bind(child: ChildHandle, assertBackendCurrent: () => void): ChildGuardBinding {
      const current = () => { assertGeneration(); assertBackendCurrent() }
      const network = options.network ? webfetchNetworkFor(selection, options.network.guard, current) : undefined
      const fetching = network ? { network } : {}
      if (!broker && !member && !listing && !kernel) return { child, agent: approved.buildAgentID, coverage, assertCurrent: current, ...fetching }
      const sessionID = child.locator.sessionID
      const producers: Producer[] = []
      try {
        if (broker) producers.push(broker.bindChild({ child, sessionID, agent: approved.buildAgentID, cwd: spec.cwd, assertCurrent: current }))
        if (listing) producers.push(listing.bindChild({ child, sessionID, agent: approved.buildAgentID, cwd: spec.cwd, assertCurrent: current }))
        if (kernel && grant) producers.push(kernel.bindChild({ child, sessionID, agent: approved.buildAgentID, taskId: spec.taskId, grant, assertCurrent: current }))
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
      return { child, agent: approved.buildAgentID, coverage, ...fetching,
        assertCurrent() { current(); for (const producer of producers) producer.assertCurrent() },
        producers: combine(producers) }
    } }
  }
}
