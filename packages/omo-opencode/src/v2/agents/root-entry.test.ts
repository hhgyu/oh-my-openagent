import { expect, it } from "bun:test"
import type * as Plugin from "@opencode/plugin/promise/plugin"
import rootPlugin from "../../index"

it("normal root v2 setup registers a native agent transform and status RPC", async () => {
  let transforms = 0
  let rpcs = 0
  let hooks = 0
  const context = {
    options: {
      "omo-senpi-lsp-tools-enabled": false,
      "omo-senpi-ultrawork-disabled": true,
      "omo-senpi-todo-fanout-reminder-disabled": true,
      "omo-senpi-question-gates-disabled": true,
      "omo-senpi-comment-checker-disabled": true,
      "omo-memory-enabled": false,
      "omo-native-eval-enabled": false,
    },
    location: { directory: process.cwd() as Plugin.Context["location"]["directory"] },
    agent: {
      transform: async () => {
        transforms++
        return { dispose: async () => {} }
      },
    },
    tool: {
      hook: async () => {
        hooks++
        return { dispose: async () => {} }
      },
    },
    rpc: {
      register: async () => {
        rpcs++
        return { dispose: async () => {} }
      },
    },
  } satisfies {
    options: Plugin.Context["options"]
    location: Plugin.Context["location"]
    agent: Pick<Plugin.Context["agent"], "transform">
    tool: Pick<Plugin.Context["tool"], "hook">
    rpc: Pick<Plugin.Context["rpc"], "register">
  }
  const cleanup = await rootPlugin.setup(context as Plugin.Context)
  expect(transforms).toBe(1)
  expect(rpcs).toBe(1)
  expect(hooks).toBe(1)
  await cleanup?.()
})
