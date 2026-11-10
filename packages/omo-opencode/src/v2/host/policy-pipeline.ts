import type { Result, ToolContext } from "@opencode/plugin/promise/tool"

export interface PolicyCall {
  readonly requested: string
  readonly context?: ToolContext
  routed: string
  input: unknown
}
export interface ToolPolicies {
  readonly before?: (call: PolicyCall) => void | Promise<void>
  readonly after?: (call: Readonly<PolicyCall>, result: Result) => Result | void | Promise<Result | void>
  readonly error?: (call: Readonly<PolicyCall>, error: unknown) => void | Promise<void>
}

/** Shared by owned SDK hook integration and explicit calls. Reuse the invocation object as the marker.
 * It runs only our supplied handlers, never third-party hooks or synthetic host transcript events. */
export function createPolicyPipeline(policies: ToolPolicies = {}) {
  return {
    invocation(requested: string, input: unknown, context?: ToolContext) {
      const call: PolicyCall = { requested, routed: requested, input, context }
      Object.defineProperty(call, "requested", { value: requested, writable: false, enumerable: true })
      Object.defineProperty(call, "context", { value: context, writable: false, enumerable: true })
      let execution: Promise<Result> | undefined
      return {
        run(body: (call: Readonly<PolicyCall>) => Promise<Result>, validate?: (result: Result) => void | Promise<void>): Promise<Result> {
          if (!execution) execution = Promise.resolve().then(async () => {
            try {
              await policies.before?.(call)
              Object.freeze(call)
              const result = await body(call)
              const finalResult = (await policies.after?.(call, result)) ?? result
              await validate?.(finalResult)
              return finalResult
            } catch (error) {
              // Preserve interruptions, denials and original execution errors even if error reporting fails.
              try { await policies.error?.(call, error) } catch { /* Reporting cannot replace the original failure. */ }
              throw error
            }
          })
          return execution
        },
      }
    },
  }
}
export type PolicyPipeline = ReturnType<typeof createPolicyPipeline>
