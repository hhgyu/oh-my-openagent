import { describe, expect, test } from "bun:test"
import type * as Plugin from "@opencode/plugin/promise/plugin"
import { COMMENT_CHECKER_FEEDBACK_HEADER, type CheckResult, type CommentCheckerLogger, type RunCommentCheckerInput } from "@oh-my-opencode/comment-checker-core"
import { registerCommentChecker, type CommentCheckerRegistrationOptions } from "./index"

type Content = string | { type: string; text?: string }[] | undefined
interface FakeEvent {
  tool: string
  sessionID: string
  messageID: string
  id: string
  input: unknown
  status: "completed" | "error"
  result: { content?: Content; metadata?: Record<string, unknown> }
}

const CWD = process.platform === "win32" ? "C:\\work" : "/work"
const violation: CheckResult = { hasComments: true, message: "line 1: redundant comment" }

function fixture(options: CommentCheckerRegistrationOptions & { check?: (input: RunCommentCheckerInput) => CheckResult; binary?: string | null } = {}, hostOptions: Record<string, unknown> = {}) {
  let callback: ((event: FakeEvent) => Promise<void> | void) | undefined
  let registrations = 0, disposals = 0
  const calls: RunCommentCheckerInput[] = []
  const warnings: string[] = []
  const logger: CommentCheckerLogger = { info() {}, warn(message) { warnings.push(message) } }
  const host = { location: { directory: CWD }, options: hostOptions, tool: { hook: async (name: string, hook: typeof callback) => {
    expect(name).toBe("execute.after"); registrations++; callback = hook
    return { dispose: async () => { disposals++ } }
  } } } as unknown as Pick<Plugin.Context, "location" | "options" | "tool">
  const binary = options.binary === undefined ? "/fake/comment-checker" : options.binary
  const register = () => registerCommentChecker(host, {
    logger, env: {},
    ...options,
    component: { resolveBinary: () => binary, downloadBinary: async () => null, runCommentChecker: async input => { calls.push(input); return (options.check ?? (() => violation))(input) } },
  })
  async function fire(overrides: Partial<FakeEvent> = {}): Promise<FakeEvent> {
    const event: FakeEvent = { tool: "edit", sessionID: "ses_1", messageID: "msg_1", id: "call_1", status: "completed",
      input: { filePath: "src/a.ts", oldString: "old", newString: "new" }, result: { content: "Edit applied" }, ...overrides }
    if (!callback) throw new Error("hook not registered")
    await callback(event)
    return event
  }
  return { register, fire, calls, warnings, counts: () => ({ registrations, disposals }) }
}

describe("registerCommentChecker", () => {
  test("#given a completed edit with comments #when execute.after fires #then the checker feedback is appended to the tool result", async () => {
    const f = fixture(); await f.register()
    const event = await f.fire()
    expect(f.calls).toHaveLength(1)
    expect(f.calls[0]!.hookInput.tool_input).toMatchObject({ file_path: expect.stringContaining("a.ts"), old_string: "old", new_string: "new" })
    expect(f.calls[0]!.hookInput.session_id).toBe("ses_1")
    expect(typeof event.result.content).toBe("string")
    expect(String(event.result.content).startsWith("Edit applied\n" + COMMENT_CHECKER_FEEDBACK_HEADER)).toBe(true)
    expect(String(event.result.content)).toContain(violation.message)
  })

  test("#given the same file in one turn #when it is edited again #then it is reported once until a new assistant message starts", async () => {
    const f = fixture(); await f.register()
    await f.fire()
    expect((await f.fire({ id: "call_2" })).result.content).toBe("Edit applied")
    expect(String((await f.fire({ id: "call_3", messageID: "msg_2" })).result.content)).toContain(violation.message)
  })

  test("#given a patch tool #when it completes #then every patched file is checked and array content gains text parts", async () => {
    const f = fixture(); await f.register()
    const patchText = "*** Begin Patch\n*** Add File: one.ts\n+// one\n*** Add File: two.ts\n+// two\n*** End Patch"
    const event = await f.fire({ tool: "patch", input: { patchText }, result: { content: [{ type: "text", text: "Patched" }] } })
    expect(f.calls.map(call => call.hookInput.tool_input.file_path?.replaceAll("\\", "/").split("/").pop())).toEqual(["one.ts", "two.ts"])
    const content = event.result.content
    expect(Array.isArray(content) ? content.map(part => part.type) : []).toEqual(["text", "text", "text"])
  })

  test("#given clean output, errors, or non-mutation tools #when execute.after fires #then the result is untouched", async () => {
    const f = fixture({ check: () => ({ hasComments: false, message: "" }) }); await f.register()
    const result = { content: "Edit applied" }
    expect((await f.fire({ result })).result).toBe(result)
    for (const overrides of [{ status: "error" as const }, { tool: "read" }, { result: { content: "x", metadata: { isError: true } } }]) {
      await f.fire({ ...overrides, id: "other", sessionID: "ses_other" })
    }
    expect(f.calls).toHaveLength(1)
  })

  test("#given no checker binary #when edits complete #then the checker never runs and one warning is logged per session", async () => {
    const f = fixture({ binary: null }); await f.register()
    await f.fire(); await f.fire({ id: "call_2", messageID: "msg_2", input: { filePath: "b.ts", content: "x" } })
    await f.fire({ sessionID: "ses_2" })
    expect(f.calls).toHaveLength(0)
    expect(f.warnings).toHaveLength(2)
  })

  test("#given a checker that cannot start #when it fails once #then that session stops checking while other sessions continue", async () => {
    const f = fixture({ check: () => ({ hasComments: false, message: "", failure: { exitCode: null, stderr: "spawn ENOENT" } }) }); await f.register()
    await f.fire(); await f.fire({ id: "call_2", messageID: "msg_2", input: { filePath: "b.ts", content: "x" } })
    expect(f.calls).toHaveLength(1)
    await f.fire({ sessionID: "ses_2" })
    expect(f.calls).toHaveLength(2)
    expect(f.warnings.length).toBeGreaterThan(0)
  })

  test("#given disabling options #when registering #then no hook is installed", async () => {
    for (const key of ["omo-senpi-disabled", "omo-senpi-comment-checker-disabled"]) {
      const f = fixture({}, { [key]: true })
      await (await f.register())()
      expect(f.counts()).toEqual({ registrations: 0, disposals: 0 })
    }
    const env = fixture({ env: { OMO_SENPI_DISABLED: "1" } }); await env.register()
    expect(env.counts().registrations).toBe(0)
  })

  test("#given a registered hook #when cleanup runs twice #then the registration is disposed once and later events pass through", async () => {
    const f = fixture(); const close = await f.register()
    await close(); await close()
    expect(f.counts()).toEqual({ registrations: 1, disposals: 1 })
    expect((await f.fire()).result.content).toBe("Edit applied")
    expect(f.calls).toHaveLength(0)
  })
})
