import { expect, it } from "bun:test"
import type * as Plugin from "@opencode/plugin/promise/plugin"
import rootPlugin from "../../index"

it("normal root v2 setup registers a native agent transform and status RPC", async () => {
  let transforms = 0
  let rpcs = 0
  const context = {
    location: { directory: process.cwd() },
    agent: { transform: async () => { transforms++; return { dispose: async () => {} } } },
    rpc: { register: async () => { rpcs++; return { dispose: async () => {} } } },
  } as unknown as Plugin.Context
  const cleanup = await rootPlugin.setup(context)
  expect(transforms).toBe(1)
  expect(rpcs).toBe(1)
  await cleanup?.()
})
