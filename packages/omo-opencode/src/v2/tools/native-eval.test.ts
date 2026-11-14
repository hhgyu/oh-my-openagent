import { describe, expect, test } from "bun:test"
import { Error as ToolError, type ToolContext } from "@opencode/plugin/promise/tool"
import {
  EVAL_DENIED_AGENTS,
  NATIVE_EVAL_PERMISSION,
  NATIVE_EVAL_PLACEHOLDER_DESCRIPTION,
  NATIVE_EVAL_TOOL_NAME,
  evalSessionEnvironment,
  evalStateDir,
  registerNativeEval,
} from "./native-eval"
import {
  NO_PROCESS_EVENTS as noProcess,
  fakeEvalBackend as fakeBackend,
  fakeEvalHost as fakeHost,
} from "./test-support"

function context(overrides: Partial<ToolContext> = {}): ToolContext {
  return {
    sessionID: "ses_root",
    agent: "sisyphus",
    messageID: "msg_1",
    id: "call_1",
    signal: new AbortController().signal,
    progress: async () => {},
    ...overrides,
  } as ToolContext
}

describe("native eval tool", () => {
  test("#given the component registers #when the tool is listed #then it is the Native `eval` with codemode off and the eval permission", async () => {
    // given
    const fake = fakeHost()

    // when
    const dispose = await registerNativeEval(fake.host, { backend: fakeBackend().backend, processEvents: noProcess })

    // then
    expect(fake.tools).toHaveLength(1)
    const tool = fake.tools[0]
    expect(tool?.name).toBe(NATIVE_EVAL_TOOL_NAME)
    expect(tool?.options).toEqual({ codemode: false, permission: NATIVE_EVAL_PERMISSION })
    expect(tool?.description).toBe(NATIVE_EVAL_PLACEHOLDER_DESCRIPTION)
    expect((tool?.input as { properties: Record<string, unknown> }).properties).toHaveProperty("isolate")
    await dispose()
  })

  test("#given read-only roles #when the denied set is derived #then they mirror the agents that deny bash", () => {
    // given / when
    const denied = [...EVAL_DENIED_AGENTS].sort()

    // then
    expect(denied).toEqual(["explore", "librarian", "metis", "momus", "multimodal-looker", "oracle", "prometheus"])
  })

  test("#given a cell call #when it runs #then the tool context signal reaches codemode and the result is adapted", async () => {
    // given
    const fake = fakeHost()
    const seen: { signal?: AbortSignal; id?: string; params?: unknown }[] = []
    const made = fakeBackend(async (id, params, signal) => {
      seen.push({ id, params, signal })
      return { content: [{ type: "text", text: "42" }], details: { language: "js" } }
    })
    const dispose = await registerNativeEval(fake.host, { backend: made.backend, processEvents: noProcess })
    const caller = context()

    // when
    const result = await fake.tools[0]?.execute({ language: "js", code: "6*7", summary: "s" }, caller)

    // then
    expect(result).toEqual({ content: [{ type: "text", text: "42" }], metadata: { nativeEval: { language: "js" } } })
    expect(seen).toEqual([
      { id: "call_1", params: { language: "js", code: "6*7", summary: "s" }, signal: caller.signal },
    ])
    expect(made.state.acquired).toBe(1)
    await dispose()
    expect(made.state.disposed).toBe(1)
  })

  test("#given a running cell #when the call is aborted #then the abort propagates and the model gets a tool error", async () => {
    // given
    const fake = fakeHost()
    const made = fakeBackend(
      (_id, _params, signal) =>
        new Promise((_resolve, reject) =>
          signal.addEventListener("abort", () => reject(signal.reason), { once: true }),
        ),
    )
    const dispose = await registerNativeEval(fake.host, { backend: made.backend, processEvents: noProcess })
    const controller = new AbortController()

    // when
    const pending = fake.tools[0]?.execute(
      { language: "js", code: "await sleep()", summary: "s" },
      context({ signal: controller.signal }),
    )
    await Bun.sleep(5)
    controller.abort(Error("user interrupted"))
    const error = await pending?.catch((caught: unknown) => caught)

    // then
    expect(error).toBeInstanceOf(ToolError)
    expect((error as ToolError).message).toBe("user interrupted")
    await dispose()
  })

  test("#given an abort while codemode is still loading #when the call is aborted #then it returns without waiting for the load", async () => {
    // given
    const fake = fakeHost()
    const loading = fakeBackend(undefined, { load: () => new Promise<void>(() => {}) })
    const dispose = await registerNativeEval(fake.host, { backend: loading.backend, processEvents: noProcess })
    const controller = new AbortController()

    // when
    const pending = fake.tools[0]?.execute(
      { language: "js", code: "1", summary: "s" },
      context({ signal: controller.signal }),
    )
    controller.abort(Error("stop"))
    const error = await pending?.catch((caught: unknown) => caught)

    // then
    expect((error as Error).message).toBe("stop")
    await dispose()
  })

  test("#given a read-only agent or a child session #when eval is called #then it is refused with a model-visible reason and no runtime starts", async () => {
    // given
    const fake = fakeHost({ ses_child: { parentID: "ses_root" } })
    const made = fakeBackend()
    const dispose = await registerNativeEval(fake.host, { backend: made.backend, processEvents: noProcess })
    const tool = fake.tools[0]

    // when
    const readOnly = await tool
      ?.execute({}, context({ agent: "explore" } as Partial<ToolContext>))
      .catch((caught: unknown) => caught)
    const child = await tool
      ?.execute({}, context({ sessionID: "ses_child" } as Partial<ToolContext>))
      .catch((caught: unknown) => caught)

    // then
    expect((readOnly as Error).message).toContain("not available to the explore agent")
    expect((child as Error).message).toContain("only in root sessions")
    expect(made.state.acquired).toBe(0)
    await dispose()
  })

  test("#given the context hook #when a request is built #then children and read-only roles lose eval and roots get the loaded description", async () => {
    // given
    const fake = fakeHost({ ses_child: { parentID: "ses_root" } })
    const made = fakeBackend(undefined, {
      definition: { description: "codemode description", parameters: { type: "object", properties: { code: {} } } },
    })
    const dispose = await registerNativeEval(fake.host, { backend: made.backend, processEvents: noProcess })
    const id = fake.tools[0]?.id ?? ""
    const request = (sessionID: string, agent: string) => ({
      sessionID,
      agent,
      tools: { [id]: { description: "placeholder", input: {} } } as Record<
        string,
        { description: string; input: unknown }
      >,
    })
    await fake.tools[0]?.execute({ language: "js", code: "1", summary: "s" }, context())
    await Bun.sleep(1)

    // when
    const child = request("ses_child", "sisyphus"),
      readOnly = request("ses_root", "oracle"),
      root = request("ses_root", "sisyphus")
    for (const value of [child, readOnly, root]) await fake.hooks[0]?.(value)

    // then
    expect(child.tools[id]).toBeUndefined()
    expect(readOnly.tools[id]).toBeUndefined()
    expect(root.tools[id]).toEqual({
      description: "codemode description",
      input: { type: "object", properties: { code: {} } },
    })
    await dispose()
  })

  test("#given a session with a runtime #when OpenCode deletes the session #then the backend releases its kernels", async () => {
    // given
    const fake = fakeHost()
    const made = fakeBackend()
    const dispose = await registerNativeEval(fake.host, { backend: made.backend, processEvents: noProcess })
    await fake.tools[0]?.execute({ language: "js", code: "1", summary: "s" }, context())

    // when
    fake.deleteSession("ses_root")
    await Bun.sleep(5)

    // then
    expect(made.state.released).toEqual(["ses_root"])
    await dispose()
  })

  test("#given the project directory is the home directory #when the state dir is chosen #then it never lands in ~/.omo", () => {
    // given / when
    const atHome = evalStateDir("/home/user", "ses_1", "/home/user")
    const inProject = evalStateDir("/home/user/project", "ses_1", "/home/user")

    // then
    expect(atHome.replaceAll("\\", "/")).not.toContain("/home/user/.omo")
    expect(inProject.replaceAll("\\", "/")).toContain("/home/user/project/.omo/eval/opencode-v2/")
  })

  test("#given an eval call's host session #when its kernel environment is built #then it binds that session, the project directory and the staged agent-toolkit SDK", () => {
    // given / when
    const withSdk = evalSessionEnvironment({
      directory: "/home/user/project",
      sessionID: "ses_root",
      agentToolkitSdkRoot: "/opt/omo/dist/v2/agent-toolkit-sdk",
    })
    const withoutSdk = evalSessionEnvironment({ directory: "/home/user/project", sessionID: "ses_other" })

    // then
    expect(withSdk).toEqual({
      PI_SESSION_ID: "ses_root",
      PI_SESSION_CWD: "/home/user/project",
      OMO_AGENT_TOOLKIT_SDK_ROOT: "/opt/omo/dist/v2/agent-toolkit-sdk",
    })
    expect(withoutSdk).toEqual({ PI_SESSION_ID: "ses_other", PI_SESSION_CWD: "/home/user/project" })
  })

  test("#given the goal store is on #when an eval session's environment is built #then PI_GOAL_STORE_FILE names that session's goal file", () => {
    // given / when
    const env = evalSessionEnvironment({
      directory: "/home/user/project",
      sessionID: "ses_root",
      goalStoreFile: "/home/user/project/.omo/goal/ses_root.json",
    })

    // then
    expect(env).toEqual({
      PI_SESSION_ID: "ses_root",
      PI_SESSION_CWD: "/home/user/project",
      PI_GOAL_STORE_FILE: "/home/user/project/.omo/goal/ses_root.json",
    })
  })
})
