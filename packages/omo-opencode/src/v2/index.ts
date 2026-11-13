import * as Plugin from "@opencode/plugin/promise/plugin"
import type * as EffectPlugin from "@opencode/plugin/effect/plugin"
import { fromPromise } from "@opencode/plugin/promise/adapter"
import { Effect, type Scope } from "effect"
import type { Rpc } from "@opencode/plugin"
import { z } from "zod"
import { registerAgents } from "./agents"
import { createMutationRuntime } from "./hooks/runtime"
import { registerGitMasterReadHook } from "./hooks/git-master"
import { registerCommentChecker } from "./hooks/comment-checker"
import { registerQuestionGates } from "./hooks/question-gates"
import { registerTodoFanoutReminder } from "./hooks/todo-fanout-reminder"
import { registerUltrawork } from "./hooks/ultrawork"
import { loadRuntimeConfig } from "./config/runtime"
import { acquireEffectSessionBackendApi } from "./host/effect-session-backend-api"
// Type-only: the component modules load SQLite-backed journals, so they are imported only when enabled.
import type { NativeTaskEffectOwners } from "./orchestration/native-task/component"

export const PLUGIN_ID = "oh-my-openagent"
export const BOOTSTRAP_STAGE = "bootstrap"

const statusOutputSchema = z.object({
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

export interface V2HostOwners {
  /** Present only on the Effect host: the Native task component needs Effect-scoped owners. */
  readonly nativeTask?: NativeTaskEffectOwners
}

export function nativeTaskEnabled(options: Plugin.Context["options"] | undefined): boolean {
  return options?.["omo-native-task-enabled"] !== false
}

/** The lead team tools ride on the Native task component and default the same way. */
export function nativeTeamEnabled(options: Plugin.Context["options"] | undefined): boolean {
  return options?.["omo-native-team-enabled"] !== false
}

/** The blocking `workflow` tool rides on the Native task component and defaults the same way. */
function nativeDagEnabled(options: Plugin.Context["options"] | undefined): boolean {
  return options?.["omo-native-dag-enabled"] !== false
}

export async function setupV2Host(context: Plugin.Context, owners: V2HostOwners = {}): Promise<Cleanup> {
  const cleanups: Cleanup[] = []
  try {
    cleanups.push(await registerAgents(context.agent, { cwd: context.location.directory }))
    cleanups.push(await registerGitMasterReadHook(context))
    cleanups.push(await registerUltrawork(context))
    cleanups.push(await registerTodoFanoutReminder(context))
    cleanups.push(await registerQuestionGates(context))
    cleanups.push(await registerCommentChecker(context))
    if (context.options?.["omo-memory-enabled"] !== false) {
      const { registerMemoryComponent } = await import("./memory")
      cleanups.push(await registerMemoryComponent(context))
    }
    if (context.options?.["omo-senpi-lsp-tools-enabled"] !== false) {
      const snapshot = loadRuntimeConfig({ cwd: context.location.directory })
      const runtime = createMutationRuntime({
        ...(snapshot.config.formatOnMutation ? { formatOnMutation: snapshot.config.formatOnMutation } : {}),
        diagnosticsEnabled: context.options?.["omo-senpi-lsp-post-edit-diagnostics-enabled"] !== false,
      })
      cleanups.push(await runtime.register(context))
    }
    // An eval cell's `tools.task` reaches the Native task component through this port (S9d).
    const evalTask =
      owners.nativeTask && context.options?.["omo-native-eval-enabled"] !== false
        ? await import("./tools/eval-task-host-tool").then((module) => ({
            port: module.createEvalTaskPort(),
            tool: module.createEvalTaskHostTool,
          }))
        : undefined
    if (context.options?.["omo-native-eval-enabled"] !== false) {
      // Native `eval`, on by default like Native. Registers the tool only; senpi-codemode itself
      // is imported on the first call.
      const { registerNativeEval } = await import("./tools/native-eval")
      cleanups.push(await registerNativeEval(context, evalTask ? { ownedTools: [evalTask.tool(evalTask.port)] } : {}))
      if (context.options?.["omo-ulw-loop-enabled"] !== false) {
        const { registerUlwLoop } = await import("./ulw-loop")
        cleanups.push(await registerUlwLoop(context))
      }
    }
    if (owners.nativeTask) {
      const { registerNativeTaskComponent } = await import("./orchestration/native-task/component")
      // The lead team tools share the Native task component's registry, kernel and service.
      const team = nativeTeamEnabled(context.options)
        ? (await import("./orchestration/native-team/component")).registerNativeTeamComponent
        : undefined
      const dag = nativeDagEnabled(context.options)
        ? (await import("./orchestration/native-dag/component")).registerNativeDagComponent
        : undefined
      cleanups.push(
        await registerNativeTaskComponent(context, owners.nativeTask, {
          ...(team && { team }),
          ...(dag && { dag: (host) => dag(host, context.rpc) }),
          ...(evalTask && { evalTask: evalTask.port }),
        }),
      )
    }
    cleanups.push(await registerBootstrap(context.rpc))
  } catch (error) {
    for (const cleanup of cleanups.reverse()) {
      try {
        await cleanup()
      } catch (cleanupError) {
        console.error("[oh-my-openagent/v2] setup cleanup failed", cleanupError)
      }
    }
    throw error
  }
  let disposed = false
  return async () => {
    if (disposed) return
    disposed = true
    for (const cleanup of cleanups.reverse()) {
      try {
        await cleanup()
      } catch (error) {
        console.error("[oh-my-openagent/v2] cleanup failed", error)
      }
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
    // Acquired BEFORE the Promise component so scope finalization (LIFO) closes them after it.
    const nativeTask = nativeTaskEnabled(context.options)
      ? yield* Effect.flatMap(
          Effect.promise(() => import("./orchestration/native-task/component")),
          (component) => component.acquireNativeTaskEffectOwners(context, bridge),
        )
      : undefined
    yield* fromPromise({
      id: PLUGIN_ID,
      setup: (promiseContext) =>
        setupV2Host(
          {
            ...promiseContext,
            session: { ...promiseContext.session, ...bridge },
          },
          nativeTask ? { nativeTask } : {},
        ),
    }).effect(context)
  })
}

const omoV2Plugin = {
  ...Plugin.define({ id: PLUGIN_ID, setup: setupV2Host }),
  effect: setupV2EffectHost,
}

export default omoV2Plugin
