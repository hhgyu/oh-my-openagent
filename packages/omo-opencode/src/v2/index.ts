import * as Plugin from "@opencode/plugin/promise/plugin"
import type * as EffectPlugin from "@opencode/plugin/effect/plugin"
import { fromPromise } from "@opencode/plugin/promise/adapter"
import { Effect, type Scope } from "effect"
import type { Rpc } from "@opencode/plugin"
import { z } from "zod"
import { registerAgents } from "./agents"
import { acquireEffectSessionBackendApi } from "./host/effect-session-backend-api"

export const PLUGIN_ID = "oh-my-openagent"
export const BOOTSTRAP_STAGE = "bootstrap"

export const statusOutputSchema = z.object({
  ok: z.boolean(),
  stage: z.string(),
  plugin: z.string(),
})

export type StatusOutput = z.infer<typeof statusOutputSchema>

export const statusRpc = {
  id: "omo",
  methods: {
    status: {
      input: z.object({}),
      output: statusOutputSchema,
    },
  },
  events: {},
} satisfies Rpc.PortableDefinition

export async function statusHandler(): Promise<StatusOutput> {
  return {
    ok: true,
    stage: BOOTSTRAP_STAGE,
    plugin: PLUGIN_ID,
  }
}

type Cleanup = () => Promise<void> | void

export type BootstrapRpc = Pick<Plugin.Context["rpc"], "register">

export async function registerBootstrap(rpc: BootstrapRpc): Promise<Cleanup> {
  const registrations = [await rpc.register(statusRpc, { status: statusHandler })]

  return async (): Promise<void> => {
    for (const registration of registrations.reverse()) {
      try {
        await registration.dispose()
      } catch (error) {
        console.error("[oh-my-openagent/v2] cleanup failed", error)
      }
    }
  }
}

export async function setupV2Host(context: Plugin.Context): Promise<Cleanup> {
  const cleanups: Cleanup[] = []
  try {
    cleanups.push(await registerAgents(context.agent, { cwd: context.location.directory }))
    cleanups.push(await registerBootstrap(context.rpc))
  } catch (error) {
    for (const cleanup of cleanups.reverse()) {
      try { await cleanup() } catch (cleanupError) { console.error("[oh-my-openagent/v2] setup cleanup failed", cleanupError) }
    }
    throw error
  }
  let disposed = false
  return async () => {
    if (disposed) return
    disposed = true
    for (const cleanup of cleanups.reverse()) {
      try { await cleanup() } catch (error) { console.error("[oh-my-openagent/v2] cleanup failed", error) }
    }
  }
}

export function setupV2EffectHost(context: EffectPlugin.Context): Effect.Effect<void, never, Scope.Scope> {
  return Effect.gen(function* () {
    if (context.app.version !== "2.2.6") {
      return yield* Effect.die(new Error("Effect session transport requires verified OpenCode 2.2.6"))
    }
    // Acquire first: component cleanup can still use this API before its owner finalizer joins requests.
    const bridge = yield* acquireEffectSessionBackendApi(context.session)
    console.info("[oh-my-openagent/v2] Effect session transport ready", context.app.version)
    yield* fromPromise({
      id: PLUGIN_ID,
      setup: (promiseContext) => setupV2Host({
        ...promiseContext,
        session: { ...promiseContext.session, ...bridge },
      }),
    }).effect(context)
  })
}

export const omoV2Plugin = {
  ...Plugin.define({ id: PLUGIN_ID, setup: setupV2Host }),
  effect: setupV2EffectHost,
}

export default omoV2Plugin
