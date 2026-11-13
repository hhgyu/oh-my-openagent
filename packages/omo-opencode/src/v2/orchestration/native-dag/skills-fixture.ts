import { Error as ToolError } from "@opencode/plugin/promise/tool"
import { buildSkillPrepend, resolveTaskAgents } from "@oh-my-opencode/senpi-task"
import { Effect, Scope } from "effect"
import { join, resolve } from "node:path"
import { acquireEffectPermissionApi } from "../../host/effect-permission-api"
import {
  prepareNativeTaskRuntime,
  type NativeSkillCaller,
  type NativeTaskPreparationOptions,
} from "../../tools/native-task-preparation"
import type { createNativeDagRuntime } from "./runtime"
import { nativeDagSkillAuthority } from "./skills"

type SkillsResult = Awaited<ReturnType<NativeTaskPreparationOptions["skills"]["list"]>>
type SkillAssert = {
  readonly sessionID: string
  readonly agent?: string
  readonly action: string
  readonly resources: readonly string[]
}

/** The genuine caller of the workflow call: the root session and its agent. The fixture supplies
 * only the plain values the SDK's branded ids carry. */
export const ROOT_CALLER = {
  sessionID: "ses_dag_root",
  agent: "sisyphus",
  messageID: "msg_root",
  id: "call_root",
} as const
const rootCaller = ROOT_CALLER as unknown as NativeSkillCaller

/** A real S2 prepared Native task runtime over a unit host: a mutable skill listing read FRESH on
 * every authorization, a joined permission owner that records each `skill` assert and denies the
 * ids in `denied`, and `off` disabled by configuration. Its `authorizeSkills` is the one the DAG
 * component binds per call. */
export async function preparedSkillHost(directory: string) {
  const cwd = resolve(directory),
    home = join(cwd, "virtual-home"),
    userConfig = join(home, ".omo", "omo.jsonc")
  const files: Record<string, unknown> = { [userConfig]: { disabled_skills: ["off"], memory: { enabled: false } } }
  const skills: SkillsResult = { location: { directory: cwd }, data: [] }
  const asserts: SkillAssert[] = [],
    denied = new Set<string>()
  const permission = Effect.runSync(
    Effect.provideService(
      acquireEffectPermissionApi({
        assert: (request) => {
          asserts.push({
            sessionID: request.sessionID,
            ...(request.agent !== undefined && { agent: request.agent }),
            action: request.action,
            resources: [...request.resources],
          })
          return request.resources.some((id) => denied.has(id))
            ? Effect.fail(new ToolError({ message: `skill ${request.resources.join(",")} denied` }))
            : Effect.void
        },
      }),
      Scope.Scope,
      Scope.makeUnsafe(),
    ),
  )
  const prepared = await prepareNativeTaskRuntime({
    cwd,
    signal: new AbortController().signal,
    assertCurrent() {},
    permission,
    canonical: { resolveTaskAgents, buildSkillPrepend },
    skills: {
      async list() {
        return structuredClone(skills)
      },
    },
    models: {
      model: {
        async list() {
          return { location: { directory: cwd }, data: [] }
        },
      },
      provider: {
        async list() {
          return { location: { directory: cwd }, data: [] }
        },
      },
    },
    configOptions: {
      env: { HOME: home },
      platform: "linux",
      fileSystem: {
        existsSync: (path) => Object.hasOwn(files, path),
        readFileSync: (path) => {
          if (!Object.hasOwn(files, path)) throw Error("Virtual config only")
          return JSON.stringify(files[path])
        },
      },
    },
  })
  return {
    asserts,
    denied,
    /** Publishes a skill in the host listing; its SDK id is `<name>-id`. */
    addSkill(name: string, content: string): string {
      const path = join(cwd, ".agents", "skills", name, "SKILL.md")
      skills.data.push({ id: `${name}-id`, name, path, content })
      return path
    },
    /** The component's per-call authority: S2 `authorizeSkills` for the root caller, Native's materializer. */
    authority: (runtime: ReturnType<typeof createNativeDagRuntime>) =>
      nativeDagSkillAuthority({
        store: runtime.store,
        cwd,
        authorize: (names) => prepared.authorizeSkills(rootCaller, names, new AbortController().signal),
      }),
  }
}
