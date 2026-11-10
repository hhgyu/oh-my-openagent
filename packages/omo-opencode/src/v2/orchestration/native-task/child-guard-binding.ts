import type { ManagedStartSpec } from "@oh-my-opencode/senpi-task/manager-kernel"
import type { ChildGuardBinding } from "../../host/owned-child-tool-guard"
import type { ChildHandle } from "../../host/session-backend"
import type { HostGrantRequirement, PreparedHostTaskGrant } from "./host-grant"
import type { ReadonlyBrokerOwner } from "./live-readonly-producer"

export interface NativeChildGuardBindingOptions {
  readonly assertGeneration: () => void
  /** Live dedicated broker registration. Absent: a curated selection stays unbound and is refused. */
  readonly readonly?: ReadonlyBrokerOwner
}
type Coverage = NonNullable<ChildGuardBinding["coverage"]>

/** Trusted component binder for the runtime `childGuardBinding` seam. Only producers that are
 * actually installed are claimed as bound; kernel/member/network requirements stay unbound, so a
 * selection needing them is refused by the runner as incomplete, never silently widened. */
export function createNativeChildGuardBinding(options: NativeChildGuardBindingOptions) {
  const { assertGeneration } = options
  return function childGuardBinding(spec: ManagedStartSpec, approved: { readonly buildAgentID: string; readonly selection: PreparedHostTaskGrant }) {
    const broker = approved.selection.requirements.includes("curated-readonly-broker") ? options.readonly : undefined
    const requirement: HostGrantRequirement = "curated-readonly-broker"
    const coverage: Coverage = broker
      ? { boundRequirements: [requirement], targets: approved.selection.bindingSlots.filter(slot => slot.requirement === requirement)
        .map(slot => ({ requirement, nativeName: slot.nativeName, hostID: broker.hostID })) }
      : { boundRequirements: [] }
    return { coverage, assertCurrent: assertGeneration, bind(child: ChildHandle, assertBackendCurrent: () => void): ChildGuardBinding {
      const current = () => { assertGeneration(); assertBackendCurrent() }
      if (!broker) return { child, agent: approved.buildAgentID, coverage, assertCurrent: current }
      const producer = broker.bindChild({ child, sessionID: child.locator.sessionID, agent: approved.buildAgentID, cwd: spec.cwd, assertCurrent: current })
      return { child, agent: approved.buildAgentID, coverage,
        assertCurrent() { current(); producer.assertCurrent() },
        producers: { revoke: () => producer.revoke(), join: () => producer.join() } }
    } }
  }
}
