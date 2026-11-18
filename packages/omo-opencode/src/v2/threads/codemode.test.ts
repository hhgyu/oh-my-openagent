import { afterEach, describe, expect, test } from "bun:test"
import type { Info, Result } from "@opencode/plugin/promise/tool"
import { registerThreadCodemodeTools, THREAD_CODEMODE_METADATA_KEY } from "./codemode"
import { createThreadComponent, type ThreadComponent } from "./component"
import { callerOf, createFakeThreadHost } from "./test-support"

const live: { component: ThreadComponent; fake: ReturnType<typeof createFakeThreadHost> }[] = []

function fakeToolHost(existing: readonly string[] = []) {
  const tools: (Info & { id: string })[] = existing.map(
    (name, index) => ({ name, id: `tool_${index}`, description: "", input: {} }) as unknown as Info & { id: string },
  )
  const tool = {
    async transform(callback: (editor: unknown) => void) {
      callback({ list: () => tools, add: (info: Info) => tools.push({ ...info, id: `tool_${tools.length}` }) })
      return { dispose: async () => undefined }
    },
  }
  return { tool: tool as never, tools }
}

async function setup() {
  const fake = createFakeThreadHost()
  fake.addSession({ id: "ses_a", title: "alpha", busy: 10, idle: 20 })
  fake.addSession({ id: "ses_b", title: "beta", busy: 10, idle: 20 })
  const component = createThreadComponent(fake.host, { agentDir: fake.agentDir, env: {} })
  await component.start()
  live.push({ component, fake })
  return { fake, component }
}

function threadResult<T>(result: Result): T {
  const metadata = result.metadata?.[THREAD_CODEMODE_METADATA_KEY] as { result: T } | undefined
  if (metadata === undefined) throw Error("no thread result in the Code Mode metadata")
  return metadata.result
}

function codemodeTool(tools: readonly Info[], name: string): Info {
  const found = tools.find((entry) => entry.name === name)
  if (found === undefined) throw Error(`no Code Mode tool ${name}`)
  return found
}

afterEach(async () => {
  for (const entry of live.splice(0)) {
    await entry.component.close()
    entry.fake.cleanup()
  }
})

describe("V2 thread tools in Code Mode", () => {
  describe("#given the thread component and an empty tool registry", () => {
    test("#when registered #then every owned thread tool is added as a Code Mode tool with the same name and schema", async () => {
      // given
      const { component } = await setup()
      const host = fakeToolHost()

      // when
      await registerThreadCodemodeTools(host.tool, component.tools, () => undefined)

      // then
      expect(host.tools.map((entry) => entry.name).sort()).toEqual(component.tools.map((entry) => entry.name).sort())
      expect(host.tools).toHaveLength(18)
      for (const entry of host.tools) {
        expect(entry.options).toEqual({ codemode: true })
        const owned = component.tools.find((candidate) => candidate.name === entry.name)
        expect(entry.input).toEqual(owned?.parameters as Info["input"])
      }
    })

    test("#when thread_list runs from a Code Mode cell #then it returns the same threads as the eval host tool", async () => {
      // given
      const { component } = await setup()
      const host = fakeToolHost()
      await registerThreadCodemodeTools(host.tool, component.tools, () => undefined)

      // when
      const result = await codemodeTool(host.tools, "thread_list").execute({}, callerOf("ses_a"))

      // then
      const listed = threadResult<{ kind: string; threads: { thread_id: string }[] }>(result)
      expect(listed.kind).toBe("ok")
      expect(listed.threads.map((thread) => thread.thread_id).sort()).toEqual(["ses_a", "ses_b"])
      expect(result.content[0]).toMatchObject({ type: "text" })
    })

    test("#when thread_send runs from a Code Mode cell #then the permission is asserted on the Code Mode call and B gets the message", async () => {
      // given
      const { fake, component } = await setup()
      const host = fakeToolHost()
      await registerThreadCodemodeTools(host.tool, component.tools, () => undefined)

      // when
      const result = await codemodeTool(host.tools, "thread_send").execute(
        { thread: "beta", message: "from code mode" },
        callerOf("ses_a"),
      )

      // then
      const sent = threadResult<Record<string, unknown>>(result)
      expect(sent).toMatchObject({ kind: "ok", thread_id: "ses_b" })
      expect(fake.asserts[0]).toMatchObject({
        sessionID: "ses_a",
        action: "thread_send",
        resources: ["ses_b"],
        source: { type: "tool", messageID: "msg_caller", id: "call_eval" },
      })
      expect(fake.synthetics[0]?.text).toContain('"from code mode"')
    })

    test("#when the thread_send permission is refused #then the refusal reaches OpenCode unchanged", async () => {
      // given
      const { fake, component } = await setup()
      const host = fakeToolHost()
      await registerThreadCodemodeTools(host.tool, component.tools, () => undefined)
      const refusal = { _tag: "PermissionRejected" }
      fake.host.permission.assert = async () => {
        throw refusal
      }

      // when
      const attempt = codemodeTool(host.tools, "thread_send").execute(
        { thread: "beta", message: "no" },
        callerOf("ses_a"),
      )

      // then
      await expect(attempt).rejects.toBe(refusal)
      expect(fake.synthetics).toHaveLength(0)
    })
  })

  describe("#given another plugin already registered a thread tool name", () => {
    test("#when registered #then no thread tool is added and the collision is logged", async () => {
      // given
      const { component } = await setup()
      const host = fakeToolHost(["thread_list"])
      const lines: string[] = []

      // when
      await registerThreadCodemodeTools(host.tool, component.tools, (line) => lines.push(line))

      // then
      expect(host.tools.map((entry) => entry.name)).toEqual(["thread_list"])
      expect(lines).toEqual(["Code Mode thread tools stay off: thread_list already registered"])
    })
  })
})
