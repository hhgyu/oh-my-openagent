import type { filterSharedParentTools } from "@oh-my-opencode/senpi-task"
import { BUILTIN_AGENTS, CURATED_READONLY_AGENT_NAMES } from "@oh-my-opencode/senpi-task/agents-builtin"
import type { ManagedStartSpec, ManagerStartSpec, ResolvedChildPlan } from "@oh-my-opencode/senpi-task/manager-kernel"
import type { AgentDomain } from "@opencode/plugin/promise/agent"
import type { ToolContext } from "@opencode/plugin/promise/tool"
import type { ListedTool } from "../../host/tool-registry"
import type { ToolCallAuthority } from "../../host/tool-kernel"
import { hasJoinedPermissionCancellation, type JoinedPermissionApi } from "../../host/effect-permission-api"
import { hostActionReason } from "../../host/host-action"

type NativeTool = { readonly name: string; readonly exposure?: "direct" | "search" }
type CatalogTool = Pick<ListedTool, "id" | "name" | "options">
export type HostGrantRequirement =
  "curated-readonly-broker" | "kernel-live-bindings" | "member-live-bindings" | "codemode-network-guard"
export interface HostGrantPreparationInput {
  readonly spec: ManagerStartSpec
  readonly plan: ResolvedChildPlan
  readonly nativeTools: readonly NativeTool[]
  readonly catalog: readonly CatalogTool[]
  readonly includeTaskTools: boolean
  readonly uiOnlyToolNames?: readonly string[]
  readonly customCounterparts?: readonly { readonly nativeName: string; readonly hostID: string }[]
  readonly canonical: { readonly filterSharedParentTools: typeof filterSharedParentTools }
}

const stock: ReadonlyMap<string, string> = new Map(
  Object.entries({
    read: "read",
    edit: "edit",
    write: "write",
    grep: "grep",
    bash: "shell",
    find: "glob",
    web_fetch: "webfetch",
    webfetch: "webfetch",
    web_search: "websearch",
  }),
)

/** Planning DATA only. No caller, executable, SDK domain or launch capability. */
export interface PreparedHostTaskGrant {
  readonly selected: readonly { readonly nativeName: string; readonly hostID: string }[]
  readonly deniedHostIDs: readonly string[]
  readonly unavailableNativeNames: readonly string[]
  readonly requirements: readonly HostGrantRequirement[]
  readonly bindingSlots: readonly { readonly requirement: HostGrantRequirement; readonly nativeName: string }[]
  readonly allowsCodeModeTransport: boolean
  /** Delegation is agent-scoped. Native model spill/fallback is not model-pin authority. */
  readonly modelCoverage: "native-selection-with-unchanged-persona-and-tool-policy"
}

/** Recovery reuses the SAME pure selection over the persisted rebuilt ManagedStartSpec. No
 * ResolvedChildPlan is fabricated and Native model distribution is not rerun. */
export interface HostGrantRecoveryInput extends Omit<HostGrantPreparationInput, "spec" | "plan"> {
  readonly spec: ManagedStartSpec
}
type GrantPolicy = {
  readonly agentType?: string
  readonly toolAllowlist?: readonly string[]
  readonly toolDenylist?: readonly string[]
  readonly kernelTools?: ManagerStartSpec["kernelTools"]
  readonly members: readonly string[]
}

export function prepareHostTaskGrant(input: HostGrantPreparationInput): PreparedHostTaskGrant {
  return selectHostTaskGrant(
    {
      agentType: input.plan.agentType,
      toolAllowlist: input.plan.toolAllowlist,
      toolDenylist: input.plan.toolDenylist,
      kernelTools: input.spec.kernelTools,
      members: (input.spec.memberScopedTools ?? []).map((tool) => tool.name),
    },
    input,
  )
}
export function prepareRecoveryHostGrant(input: HostGrantRecoveryInput): PreparedHostTaskGrant {
  // Member tools are transient: persisted names still require live member bindings, never a grant.
  return selectHostTaskGrant(
    {
      agentType: input.spec.agentType,
      toolAllowlist: input.spec.toolAllowlist,
      toolDenylist: input.spec.toolDenylist,
      kernelTools: input.spec.kernelTools,
      members: input.spec.memberScopedTools?.map((tool) => tool.name) ?? input.spec.memberScopedToolNames ?? [],
    },
    input,
  )
}
function selectHostTaskGrant(
  policy: GrantPolicy,
  input: Omit<HostGrantPreparationInput, "spec" | "plan">,
): PreparedHostTaskGrant {
  if (typeof input.includeTaskTools !== "boolean") throw Error("Canonical includeTaskTools is required")
  const catalog = new Map<string, CatalogTool>()
  for (const tool of input.catalog) {
    if (!tool.id || !tool.name || catalog.has(tool.id)) throw Error("Ambiguous actual host catalog")
    catalog.set(tool.id, tool)
  }
  const nativeNames = new Set<string>()
  for (const tool of input.nativeTools) {
    if (!tool.name || nativeNames.has(tool.name)) throw Error("Ambiguous canonical Native surface")
    nativeNames.add(tool.name)
  }
  const custom = new Map<string, string>()
  for (const pair of input.customCounterparts ?? []) {
    if (
      !nativeNames.has(pair.nativeName) ||
      !catalog.has(pair.hostID) ||
      custom.has(pair.nativeName) ||
      stock.has(pair.nativeName)
    )
      throw Error("Invalid or overriding custom counterpart")
    custom.set(pair.nativeName, pair.hostID)
  }
  // SAME Native family/UI filtering; no copied prefix implementation or root value import.
  const visible = input.canonical.filterSharedParentTools(input.nativeTools, {
    includeTaskTools: input.includeTaskTools,
    uiOnlyToolNames: input.uiOnlyToolNames,
  })
  if (visible.some((tool) => !nativeNames.has(tool.name))) throw Error("Canonical filter returned a foreign tool")
  const agentType = policy.agentType
  const curated = agentType !== undefined && CURATED_READONLY_AGENT_NAMES.has(agentType)
  const floor = curated
    ? (BUILTIN_AGENTS[agentType]?.tools ?? []).filter((rule) => rule.allow).map((rule) => rule.pattern)
    : undefined
  const allow =
    floor === undefined
      ? policy.toolAllowlist
      : floor.filter((name) => policy.toolAllowlist === undefined || policy.toolAllowlist.includes(name))
  const denied = new Set(policy.toolDenylist),
    deniedHostIDs = new Set<string>(),
    requirements = new Set<HostGrantRequirement>()
  const bindingSlots: { requirement: HostGrantRequirement; nativeName: string }[] = []
  const counterpart = (name: string): string | undefined => {
    const explicit = custom.get(name)
    const expectedName = stock.get(name) ?? name
    const explicitTool = explicit ? catalog.get(explicit) : undefined
    const matches = explicit
      ? explicitTool
        ? [explicitTool]
        : []
      : [...catalog.values()].filter((tool) => tool.name === expectedName && tool.options?.namespace === undefined)
    if (matches.length > 1) throw Error("Ambiguous actual effective tool name")
    const tool = matches[0]
    if (!tool || (tool.options?.namespace === undefined && ["subagent", "execute"].includes(tool.name)))
      return undefined
    return tool.id
  }
  for (const name of denied) {
    const id = counterpart(name)
    if (id) deniedHostIDs.add(id)
  }
  const selected: { nativeName: string; hostID: string }[] = [],
    unavailable: string[] = []
  for (const tool of visible) {
    if ((allow !== undefined && !allow.includes(tool.name)) || denied.has(tool.name)) continue
    if (curated && tool.name === "bash") {
      requirements.add("curated-readonly-broker")
      bindingSlots.push({ requirement: "curated-readonly-broker", nativeName: tool.name })
      // A catalog name cannot impersonate the original structured broker.
      unavailable.push(tool.name)
      continue
    }
    const id = counterpart(tool.name)
    if (!id) {
      unavailable.push(tool.name)
      continue
    }
    if (!deniedHostIDs.has(id)) selected.push(Object.freeze({ nativeName: tool.name, hostID: id }))
  }
  if (policy.kernelTools !== undefined) {
    requirements.add("kernel-live-bindings")
    for (const descriptor of policy.kernelTools.descriptors ?? [])
      bindingSlots.push({ requirement: "kernel-live-bindings", nativeName: descriptor.name })
  }
  if (policy.members.length) {
    requirements.add("member-live-bindings")
    for (const name of policy.members) bindingSlots.push({ requirement: "member-live-bindings", nativeName: name })
  }
  const codeMode = selected.some((pair) => {
    const tool = catalog.get(pair.hostID)
    if (!tool) throw Error("Selected host tool is absent from the actual catalog")
    return tool.options?.codemode !== false
  })
  if (codeMode) requirements.add("codemode-network-guard")
  return Object.freeze({
    selected: Object.freeze(selected),
    deniedHostIDs: Object.freeze([...deniedHostIDs]),
    unavailableNativeNames: Object.freeze(unavailable),
    requirements: Object.freeze([...requirements]),
    bindingSlots: Object.freeze(bindingSlots.map((slot) => Object.freeze(slot))),
    allowsCodeModeTransport: codeMode,
    modelCoverage: "native-selection-with-unchanged-persona-and-tool-policy" as const,
  })
}

/** Pure FINAL-leaf decision, never authority. Actual SDK wrappers must FIRST
 * verify original approved admission/child custody and bind required producers. */
export function checkHostGrantTarget(
  selection: PreparedHostTaskGrant,
  actualHostID: string,
  coverage: {
    /** DATA derived by a later binder AFTER validating actual original producers.
     * Supplying this record is never proof of authority or child custody. */
    readonly boundRequirements: readonly HostGrantRequirement[]
    readonly targets?: readonly {
      readonly requirement: HostGrantRequirement
      readonly nativeName: string
      readonly hostID: string
    }[]
  } = { boundRequirements: [] },
): "selected" | "denied" | "requires-bindings" {
  const covered = new Set(coverage.boundRequirements)
  if (selection.deniedHostIDs.includes(actualHostID)) return "denied"
  const selected =
    selection.selected.some((pair) => pair.hostID === actualHostID) ||
    (coverage.targets ?? []).some(
      (target) =>
        target.hostID === actualHostID &&
        covered.has(target.requirement) &&
        selection.bindingSlots.some(
          (slot) => slot.requirement === target.requirement && slot.nativeName === target.nativeName,
        ),
    )
  if (
    selection.requirements.some((requirement) => !covered.has(requirement)) ||
    selection.bindingSlots.some(
      (slot) =>
        !(coverage.targets ?? []).some(
          (target) => target.requirement === slot.requirement && target.nativeName === slot.nativeName && target.hostID,
        ),
    )
  )
    return "requires-bindings"
  return selected ? "selected" : "denied"
}

/** This factory does not register, open sessions, or retain original operations.
 * Native's hook/service owner MUST await and track the ORIGINAL returned method
 * promise, including target-phase approval finalizers after outer callback abort. */
export function createHostBuildAuthorizer(options: {
  readonly callAuthority: ToolCallAuthority
  readonly permission: JoinedPermissionApi
  readonly agents: Pick<AgentDomain, "list">
  readonly assertCurrent: () => void
}) {
  if (!hasJoinedPermissionCancellation(options.permission))
    throw Error("Original genuine joined permission owner required")
  return Object.freeze({
    forCall(caller: ToolContext) {
      const token = options.callAuthority.capture(caller)
      options.callAuthority.assertCall(token)
      const lease = options.callAuthority.parent(token),
        callerSignal = caller.signal
      const source = Object.freeze({
        sessionID: caller.sessionID,
        agent: caller.agent,
        messageID: caller.messageID,
        id: caller.id,
      })
      // A host-originated action (restart recovery, D-037) has no tool call to name as the source.
      const hostAction = hostActionReason(caller)
      // No raw ToolContext retained; these signals narrow an already-owned call.
      function current() {
        callerSignal.throwIfAborted()
        options.assertCurrent()
        options.callAuthority.assert(token, lease)
        options.callAuthority.assertCall(token)
        token.assertAdmission()
      }
      /** The genuine joined subagent permission request of THIS call, then an unchanged recheck. */
      async function approve(
        agentID: string,
        select: () => PreparedHostTaskGrant,
        fingerprint: (selection: PreparedHostTaskGrant) => string,
        unchanged: () => boolean,
        operationSignal: AbortSignal,
        taskID?: string,
      ) {
        const before = select(),
          footprint = fingerprint(before)
        const roster = await options.agents.list()
        current()
        operationSignal.throwIfAborted()
        const matches = roster.data.filter((agent) => agent.id === agentID)
        const [agent] = matches
        if (matches.length !== 1 || !agent)
          throw Error(
            `Actual child agent ${agentID} is unavailable or ambiguous. Check agents.${agentID} configuration diagnostics and reload OmO, or register that exact agent ID in OpenCode.`,
          )
        const buildAgentID = agent.id
        const signal = AbortSignal.any([callerSignal, operationSignal, token.admissionSignal])
        await options.permission.assert(
          {
            sessionID: source.sessionID,
            agent: source.agent,
            action: "subagent",
            resources: [buildAgentID],
            ...(hostAction === undefined
              ? { source: { type: "tool" as const, messageID: source.messageID, id: source.id } }
              : { metadata: { omoHostAction: hostAction, ...(taskID === undefined ? {} : { omoTaskId: taskID }) } }),
          },
          { signal },
        )
        current()
        signal.throwIfAborted()
        if (!unchanged() || fingerprint(select()) !== footprint)
          throw Error("Native grant preparation changed during approval")
        return Object.freeze({
          buildAgentID,
          selection: before,
          /** Still DATA: later runtime must attach to original StartAdmission or recovery identity. */
          authorityIssued: false as const,
        })
      }
      return Object.freeze({
        async authorize(input: HostGrantPreparationInput, operationSignal: AbortSignal) {
          current()
          operationSignal.throwIfAborted()
          if (input.spec.parent_session_id !== source.sessionID) throw Error("Native plan has a foreign actual parent")
          const originalSpec = input.spec,
            originalPlan = input.plan
          const originalKernel = input.spec.kernelTools,
            originalMembers = input.spec.memberScopedTools
          return approve(
            input.plan.agentType ?? "build",
            () => prepareHostTaskGrant(input),
            (selection) =>
              JSON.stringify({
                selection,
                parent: input.spec.parent_session_id,
                root: input.spec.root_session_id,
                depth: input.spec.depth,
                agent: input.plan.agentType,
                instructions: input.plan.instructions,
                allow: input.plan.toolAllowlist,
                deny: input.plan.toolDenylist,
                subagents: input.plan.allowedSubagents,
                maxDepth: input.plan.maxDepth,
                executionMode: input.plan.agentExecutionMode,
                includeTaskTools: input.includeTaskTools,
              }),
            () =>
              input.spec === originalSpec &&
              input.plan === originalPlan &&
              input.spec.kernelTools === originalKernel &&
              input.spec.memberScopedTools === originalMembers,
            operationSignal,
          )
        },
        /** Fresh recovery approval: THIS call's real permission over the rebuilt persisted spec. */
        async authorizeRecovery(input: HostGrantRecoveryInput, operationSignal: AbortSignal) {
          current()
          operationSignal.throwIfAborted()
          if (input.spec.parentSessionId !== source.sessionID)
            throw Error("Native recovery has a foreign actual parent")
          const originalSpec = input.spec
          return approve(
            input.spec.agentType ?? "build",
            () => prepareRecoveryHostGrant(input),
            (selection) =>
              JSON.stringify({
                selection,
                task: input.spec.taskId,
                parent: input.spec.parentSessionId,
                root: input.spec.rootSessionId,
                depth: input.spec.depth,
                agent: input.spec.agentType,
                instructions: input.spec.instructions,
                allow: input.spec.toolAllowlist,
                deny: input.spec.toolDenylist,
                members: input.spec.memberScopedToolNames,
                includeTaskTools: input.includeTaskTools,
              }),
            () => input.spec === originalSpec,
            operationSignal,
            input.spec.taskId,
          )
        },
      })
    },
  })
}
