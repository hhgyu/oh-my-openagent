// Child side of a parent kernel-tool grant (S9d). A Native task child spawned by `tools.task({ tools })`
// from a parent `eval` cell carries the senpi-task grant: the descriptors senpi-task resolved and the
// capability it resolved them against. In V2 that capability is the main-thread proxy of the live
// capability in the codemode worker (codemode-capability.ts), so every `invoke` here is a message to the
// worker, which calls codemode's own capability.
//
// Mirrors senpi-task's in-process wrapper (kernel-tools/wrapper.ts): the fenced generation/revision tuple
// travels with every call so the parent kernel itself refuses a stale one (`kernel_tool_stale` after a
// reset), results and failures use the same `{ kernel_tool, value | error }` envelope, and the scope is
// sent only when the capability can enforce it. V2 adds the invoker identity (the child session) and a
// deny on the plugin-owned eval host tools (`task`): the worker would run such a nested call as the
// parent's eval call, never as the child.

import {
  KERNEL_TOOL_ERROR_CODES, kernelToolKey, normalizeKernelToolName, supportsInvokeScope,
  type KernelToolDescriptor, type KernelToolErrorCode, type KernelToolGrant, type KernelToolInvokeScope,
} from "@oh-my-opencode/senpi-task"

/** Plugin-owned eval host tools a closure invoked on a child's behalf must never reach. */
const CHILD_DENIED_EVAL_HOST_TOOLS: readonly string[] = Object.freeze(["task"])

export interface KernelToolOutcomeDetails {
  readonly kernel_tool: string
  readonly error?: { readonly code: KernelToolErrorCode; readonly message: string }
}

/** One child call's result in the Native envelope; `isError` marks a refusal or failure. */
export interface KernelToolOutcome {
  readonly text: string
  readonly isError: boolean
  readonly details: KernelToolOutcomeDetails
}

export interface KernelToolInvokeInput {
  readonly name: string
  readonly args: unknown
  readonly callID: string
  readonly signal: AbortSignal
}

export interface KernelToolInvoker {
  readonly descriptors: readonly KernelToolDescriptor[]
  invoke(input: KernelToolInvokeInput): Promise<KernelToolOutcome>
}

const CODES: ReadonlySet<string> = new Set(KERNEL_TOOL_ERROR_CODES)

function isErrorCode(code: string): code is KernelToolErrorCode {
  return CODES.has(code)
}

/** codemode's typed code survives the worker boundary; a released capability reads as unavailable. */
export function kernelToolOutcomeCode(error: unknown): KernelToolErrorCode {
  const code = typeof error === "object" && error !== null ? (error as { code?: unknown }).code : undefined
  if (code === "kernel_capability_released") return "tools_unavailable"
  return typeof code === "string" && isErrorCode(code) ? code : "kernel_tool_failed"
}

function success(name: string, value: unknown): KernelToolOutcome {
  return { text: JSON.stringify({ kernel_tool: name, value: value ?? null }), isError: false, details: { kernel_tool: name } }
}

export function kernelToolFailure(name: string, code: KernelToolErrorCode, message: string): KernelToolOutcome {
  const error = { code, message }
  return { text: JSON.stringify({ kernel_tool: name, error }), isError: true, details: { kernel_tool: name, error } }
}

/** The scope every invoke on the child's behalf carries, or undefined when the capability cannot enforce one. */
export function childKernelScope(grant: KernelToolGrant): KernelToolInvokeScope | undefined {
  if (grant.scope === undefined && !supportsInvokeScope(grant.capability)) return undefined
  const tools = grant.scope?.tools
  const denied = new Set(CHILD_DENIED_EVAL_HOST_TOOLS)
  return {
    tools: {
      ...(tools?.allow !== undefined && { allow: tools.allow.filter(name => !denied.has(name)) }),
      deny: [...new Set([...(tools?.deny ?? []), ...CHILD_DENIED_EVAL_HOST_TOOLS])],
    },
  }
}

export function createKernelToolInvoker(input: {
  readonly grant: KernelToolGrant
  /** The child session; sent as the invoker so codemode never attributes the call to the parent. */
  readonly invokerSessionID: string
  /** Checked before every call: a revoked binding never reaches the parent kernel again. */
  readonly isCurrent?: () => boolean
}): KernelToolInvoker {
  const { grant } = input
  const byKey = new Map(grant.descriptors.map(descriptor => [kernelToolKey(descriptor.name), descriptor]))
  const scope = childKernelScope(grant)
  return Object.freeze({
    descriptors: grant.descriptors,
    async invoke(call: KernelToolInvokeInput): Promise<KernelToolOutcome> {
      const descriptor = byKey.get(kernelToolKey(normalizeKernelToolName(call.name)))
      if (!descriptor) {
        const granted = grant.descriptors.map(entry => entry.name).join(", ")
        return kernelToolFailure(call.name, "kernel_tool_missing", `Parent kernel tool "${call.name}" was not granted to this child${granted ? ` (granted: ${granted})` : ""}.`)
      }
      if (input.isCurrent?.() === false) {
        return kernelToolFailure(descriptor.name, "tools_unavailable", `Parent kernel tool "${descriptor.name}" is no longer bound to this child.`)
      }
      const request = {
        name: descriptor.name, kernel_generation: descriptor.kernel_generation,
        definition_revision: descriptor.definition_revision, args: call.args, call_id: call.callID,
      }
      const options = { signal: call.signal, ...(scope && { scope }), invoker: { sessionId: input.invokerSessionID } }
      try {
        return success(descriptor.name, await grant.capability.invoke(request, options))
      } catch (error) {
        return kernelToolFailure(descriptor.name, kernelToolOutcomeCode(error), error instanceof Error ? error.message : String(error))
      }
    },
  })
}
