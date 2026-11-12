import { expect, it } from "bun:test"
import type * as Plugin from "@opencode/plugin/promise/plugin"
import { setupV2Host } from "../index"

it("cleans agents after RPC registration failure", async () => {
  const events: string[] = []
  const context = {
    options: { "omo-senpi-lsp-tools-enabled": false, "omo-senpi-ultrawork-disabled": true, "omo-senpi-todo-fanout-reminder-disabled": true, "omo-senpi-question-gates-disabled": true, "omo-senpi-comment-checker-disabled": true, "omo-memory-enabled": false, "omo-native-eval-enabled": false },
    location: { directory: process.cwd() },
    agent: { transform: async () => ({ dispose: async () => { events.push("agents") } }) },
    tool: { hook: async () => ({ dispose: async () => { events.push("git-master") } }) },
    rpc: { register: async () => { throw new Error("RPC failed") } },
  } as unknown as Plugin.Context
  await expect(setupV2Host(context)).rejects.toThrow("RPC failed")
  expect(events).toEqual(["git-master", "agents"])
})

it("disposes RPC then agents exactly once", async () => {
  const events: string[] = []
  const context = {
    options: { "omo-senpi-lsp-tools-enabled": false, "omo-senpi-ultrawork-disabled": true, "omo-senpi-todo-fanout-reminder-disabled": true, "omo-senpi-question-gates-disabled": true, "omo-senpi-comment-checker-disabled": true, "omo-memory-enabled": false, "omo-native-eval-enabled": false },
    location: { directory: process.cwd() },
    agent: { transform: async () => ({ dispose: async () => { events.push("agents") } }) },
    tool: { hook: async () => ({ dispose: async () => { events.push("git-master") } }) },
    rpc: { register: async () => ({ dispose: async () => { events.push("rpc") } }) },
  } as unknown as Plugin.Context
  const cleanup = await setupV2Host(context)
  await cleanup()
  await cleanup()
  expect(events).toEqual(["rpc", "git-master", "agents"])
})

