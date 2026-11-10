import { describe, expect, test } from "bun:test"
import type * as Plugin from "@opencode/plugin/promise/plugin"
import type { SessionContext, SessionPrompt } from "@opencode/plugin/promise/session"
import { ULTRAWORK_DEFAULT_PROMPT, ULTRAWORK_GPT_PROMPT } from "@oh-my-opencode/prompts-core"
import { registerUltrawork } from "./index"

type Host = Pick<Plugin.Context, "session" | "options">

function fixture(options: { children?: string[]; hostOptions?: Record<string, unknown>; failContext?: boolean } = {}) {
  const hooks = new Map<string, (input: unknown) => unknown>()
  let disposals = 0
  const host = {
    options: options.hostOptions ?? {},
    session: {
      hook: async (name: string, callback: (input: unknown) => unknown) => {
        if (name === "context" && options.failContext) throw new Error("context hook unavailable")
        hooks.set(name, callback)
        return { dispose: async () => { disposals++ } }
      },
      get: async ({ sessionID }: { sessionID: string }) => ({ id: sessionID, parentID: options.children?.includes(sessionID) ? "parent" : undefined }),
    },
  } as unknown as Host
  async function prompt(sessionID: string, text: string, skills?: { id: string }[]) {
    const input = { sessionID, messageID: "m", delivery: "queue", prompt: { text, ...(skills ? { skills } : {}) } } as unknown as SessionPrompt
    await hooks.get("prompt")?.(input)
  }
  function request(sessionID: string, modelID = "claude-opus-4-6", agent = "sisyphus") {
    const context = { sessionID, agent, model: { id: modelID, providerID: "anthropic" }, system: [], messages: [], options: {}, tools: {} } as unknown as SessionContext
    hooks.get("context")?.(context)
    return context.system.filter(part => part.metadata?.["omo.ultrawork"] === true)
  }
  return { host, prompt, request, hooks, disposals: () => disposals }
}

describe("registerUltrawork", () => {
  describe("#given a root session prompt", () => {
    test.each([
      ["ulw fix the build", true],
      ["ultrawork: ship it", true],
      ["please fix the bug", false],
      ['what does "ulw" mean', false],
      ["open mass-ulw-refactor.md", false],
      ["do not use ulw here", false],
    ])("#when the prompt is %p #then arming is %p", async (text, armed) => {
      const f = fixture()
      await registerUltrawork(f.host)
      await f.prompt("s1", text)
      expect(f.request("s1")).toHaveLength(armed ? 1 : 0)
    })

    test("#when the session keeps working and re-mentions the keyword #then every request carries exactly one directive", async () => {
      const f = fixture()
      await registerUltrawork(f.host)
      await f.prompt("s1", "ulw do it")
      expect(f.request("s1")).toHaveLength(1)
      expect(f.request("s1")).toHaveLength(1)
      await f.prompt("s1", "ulw again")
      expect(f.request("s1")).toHaveLength(1)
    })

    test("#when one context request is transformed twice #then the directive is not duplicated", async () => {
      const f = fixture()
      await registerUltrawork(f.host)
      await f.prompt("s1", "ulw")
      const context = { sessionID: "s1", agent: "sisyphus", model: { id: "claude-opus-4-6" }, system: [], messages: [], options: {}, tools: {} } as unknown as SessionContext
      f.hooks.get("context")?.(context)
      f.hooks.get("context")?.(context)
      expect(context.system).toHaveLength(1)
    })

    test("#when the receiving model changes #then the shared prompts-core variant is selected per request", async () => {
      const f = fixture()
      await registerUltrawork(f.host)
      await f.prompt("s1", "ulw")
      expect(f.request("s1", "gpt-5.5")[0]?.text).toBe(ULTRAWORK_GPT_PROMPT)
      expect(f.request("s1", "claude-opus-4-6")[0]?.text).toBe(ULTRAWORK_DEFAULT_PROMPT)
    })
  })

  describe("#given several sessions", () => {
    test("#when only one session is armed #then other sessions are untouched", async () => {
      const f = fixture()
      await registerUltrawork(f.host)
      await f.prompt("s1", "ulw")
      expect(f.request("s1")).toHaveLength(1)
      expect(f.request("s2")).toHaveLength(0)
    })

    test("#when the keyword arrives in a child session #then it is not armed", async () => {
      const f = fixture({ children: ["child"] })
      await registerUltrawork(f.host)
      await f.prompt("child", "ulw")
      expect(f.request("child")).toHaveLength(0)
    })

    test("#when the ultrawork skill is attached #then the directive is not injected again", async () => {
      const f = fixture()
      await registerUltrawork(f.host)
      await f.prompt("s1", "ulw", [{ id: "ultrawork" }])
      expect(f.request("s1")).toHaveLength(0)
    })
  })

  describe("#given registration lifecycle", () => {
    test("#when cleanup runs twice #then both hooks are disposed once and injection stops", async () => {
      const f = fixture()
      const cleanup = await registerUltrawork(f.host)
      await f.prompt("s1", "ulw")
      await cleanup()
      await cleanup()
      expect(f.disposals()).toBe(2)
      expect(f.request("s1")).toHaveLength(0)
    })

    test("#when the context hook fails to register #then the prompt hook is disposed and the error surfaces", async () => {
      const f = fixture({ failContext: true })
      await expect(registerUltrawork(f.host)).rejects.toThrow("context hook unavailable")
      expect(f.disposals()).toBe(1)
    })

    test("#when the component is disabled #then no hook is registered", async () => {
      const f = fixture({ hostOptions: { "omo-senpi-ultrawork-disabled": true } })
      await registerUltrawork(f.host)
      expect(f.hooks.size).toBe(0)
    })
  })
})
