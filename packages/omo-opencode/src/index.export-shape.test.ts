import { describe, expect, it } from "bun:test"
import type * as Plugin from "@opencode/plugin/promise/plugin"
import pluginModule, { omoPlugin } from "./index"
import { opencodeV2Server } from "./opencode-v2/server-entry"

describe("oh-my-openagent plugin export shape", () => {
  it("keeps default module and named server exports aligned", () => {
    // given
    const defaultServer = pluginModule.server

    // when
    const namedServer = omoPlugin

    // then
    expect(typeof defaultServer).toBe("function")
    expect(namedServer).toBe(defaultServer)
    expect(pluginModule.setup).toBe(opencodeV2Server.setup)
    expect(pluginModule.effect).toBe(opencodeV2Server.effect)
    expect(typeof pluginModule.effect).toBe("function")
  })

  it("exposes and registers the native OpenCode 2 setup beside the V1 server entry", async () => {
    const registered: string[] = []
    const disposed: string[] = []
    const context = {
      options: { "omo-senpi-lsp-tools-enabled": false, "omo-senpi-ultrawork-disabled": true, "omo-senpi-todo-fanout-reminder-disabled": true, "omo-senpi-question-gates-disabled": true, "omo-senpi-comment-checker-disabled": true, "omo-memory-enabled": false, "omo-native-eval-enabled": false },
      location: { directory: process.cwd() as Plugin.Context["location"]["directory"] },
      agent: {
        transform: async (callback) => {
          expect(typeof callback).toBe("function")
          registered.push("agents")
          return { dispose: async () => { disposed.push("agents") } }
        },
      },
      tool: {
        hook: async (name, callback) => {
          expect(name).toBe("execute.after")
          expect(typeof callback).toBe("function")
          registered.push("tool-after")
          return { dispose: async () => { disposed.push("tool-after") } }
        },
      },
      rpc: {
        register: async (definition, handlers) => {
          expect(definition.id).toBe("omo")
          expect(Object.keys(definition.methods)).toEqual(["status"])
          expect(typeof Reflect.get(handlers, "status")).toBe("function")
          registered.push("rpc")
          return { dispose: async () => { disposed.push("rpc") }, events: { emit: async () => {} } }
        },
      },
    } satisfies {
      options: Plugin.Context["options"]
      location: Plugin.Context["location"]
      agent: Pick<Plugin.Context["agent"], "transform">
      tool: Pick<Plugin.Context["tool"], "hook">
      rpc: Pick<Plugin.Context["rpc"], "register">
    }

    expect(pluginModule.id).toBe("oh-my-openagent")
    expect(typeof pluginModule.server).toBe("function")
    expect(typeof pluginModule.setup).toBe("function")
    const cleanup = await pluginModule.setup(context as Plugin.Context)
    expect(registered).toEqual(["agents", "tool-after", "rpc"])
    expect(typeof cleanup).toBe("function")
    await cleanup?.()
    expect(disposed).toEqual(["rpc", "tool-after", "agents"])
  })
})
