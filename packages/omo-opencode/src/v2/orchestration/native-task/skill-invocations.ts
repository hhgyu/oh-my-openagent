import type * as Plugin from "@opencode/plugin/promise/plugin"
import type { Registration } from "@opencode/plugin/promise/registration"
import {
  classifySkillInput,
  planArtifactPathsTouched,
  skillNameFromPath,
  type SkillInvocationState,
} from "@oh-my-opencode/senpi-task"

type Host = Pick<Plugin.Context, "location" | "tool" | "event" | "skill" | "session">
type PlanArtifactReference = ReturnType<SkillInvocationState["planArtifactReferences"]>[number]
type Evidence = {
  invoked: Set<string>
  requested: Set<string>
  plans: Map<string, PlanArtifactReference>
  sequence: number
}
const KEY = Symbol.for("omo.v2.plan-gate.v1")

function sessionsFor(directory: string): Map<string, Evidence> {
  const globals = globalThis as unknown as Record<symbol, Map<string, Map<string, Evidence>> | undefined>
  const directories = (globals[KEY] ??= new Map())
  let sessions = directories.get(directory)
  if (!sessions) {
    sessions = new Map()
    directories.set(directory, sessions)
  }
  return sessions
}
function field(input: unknown, key: string): string | undefined {
  if (typeof input !== "object" || input === null) return undefined
  const value: unknown = Reflect.get(input, key)
  return typeof value === "string" ? value : undefined
}

/** Inbox user items are captured before prompt/context plugins can rewrite them. Synthetic items
 * never prove human intent. Like Native reload handoffs, state lasts only inside this process. */
export async function registerSkillInvocations(
  host: Host,
): Promise<{ stateFor(sessionID: string): SkillInvocationState; close(): Promise<void> }> {
  const sessions = sessionsFor(host.location.directory)
  const stop = new AbortController(),
    registrations: Registration[] = []
  let closed = false,
    pump: Promise<void> | undefined,
    disposal: Promise<void> | undefined
  let skillNames = new Map<string, string>()
  async function refreshSkills(): Promise<void> {
    const catalog = await host.skill.list({ location: { directory: host.location.directory } })
    if (!closed) skillNames = new Map(catalog.data.map((skill) => [skill.id, skill.name]))
  }
  function evidence(sessionID: string): Evidence {
    let state = sessions.get(sessionID)
    if (!state) {
      state = { invoked: new Set(), requested: new Set(), plans: new Map(), sequence: 0 }
      sessions.set(sessionID, state)
    }
    return state
  }
  function observeInput(sessionID: string, text: string, skills: readonly { readonly id: string }[] | undefined): void {
    const input = classifySkillInput(text)
    const attached = (skills ?? []).flatMap((skill) => {
      const name = skillNames.get(skill.id)
      return name === undefined ? [] : [name]
    })
    if (!input.invoked.length && !input.requested.length && !attached.length) return
    const state = evidence(sessionID)
    for (const name of input.invoked) state.invoked.add(name)
    for (const name of input.requested) state.requested.add(name)
    for (const name of attached) {
      state.invoked.add(name)
      state.requested.add(name)
    }
  }
  const close = (): Promise<void> =>
    (disposal ??= (async () => {
      closed = true
      stop.abort()
      try {
        await Promise.all(registrations.map((registration) => registration.dispose()))
      } finally {
        await pump
      }
    })())
  try {
    await refreshSkills()
    registrations.push(
      await host.tool.hook("execute.after", (event) => {
        if (closed || event.status !== "completed") return
        const toolName = event.tool === "patch" ? "apply_patch" : event.tool
        const path = field(event.input, "path") ?? field(event.input, "filePath") ?? field(event.input, "file_path")
        const invoked =
          toolName === "read"
            ? skillNameFromPath(path)
            : toolName === "skill"
              ? (field(event.input, "name") ?? field(event.input, "skill"))
              : undefined
        const paths = planArtifactPathsTouched({
          toolName,
          path,
          patchText: field(event.input, "patchText") ?? field(event.input, "input"),
        })
        if (!invoked && !paths.length) return
        const state = evidence(event.sessionID)
        if (invoked) state.invoked.add(skillNames.get(invoked) ?? invoked)
        for (const path of paths)
          state.plans.set(path, {
            path,
            count: (state.plans.get(path)?.count ?? 0) + 1,
            lastTouchedAt: ++state.sequence,
          })
      }),
    )
    pump = (async () => {
      try {
        for await (const event of host.event.subscribe({
          types: ["session.inbox.enqueued", "session.deleted", "skill.updated"],
          signal: stop.signal,
        })) {
          if (closed) break
          if (event.type === "skill.updated") {
            await refreshSkills()
            continue
          }
          if (event.type === "session.deleted") {
            sessions.delete(event.data.sessionID)
            continue
          }
          const item = event.data.item
          if (item.type !== "user") continue
          const source = field(item.payload.metadata, "source")
          if (source !== undefined && !["interactive", "rpc", "user"].includes(source)) continue
          // Owned children receive model-authored task/send text through the host's user inbox API.
          const root = await host.session.get({ sessionID: event.data.sessionID }).then(
            (session) => !session.parentID && session.location.directory === host.location.directory,
            (error) => {
              console.warn("[oh-my-openagent/v2] plan-gate input identity unavailable", error)
              return false
            },
          )
          if (closed || !root) continue
          observeInput(event.data.sessionID, item.payload.text, item.payload.skills)
        }
      } catch (error) {
        if (!stop.signal.aborted) console.warn("[oh-my-openagent/v2] plan-gate input stream failed", error)
      }
    })()
  } catch (error) {
    await close()
    throw error
  }
  return {
    stateFor(sessionID) {
      return {
        hasInvoked: (name) => sessions.get(sessionID)?.invoked.has(name) ?? false,
        hasUserRequested: (name) => sessions.get(sessionID)?.requested.has(name) ?? false,
        hasPlanArtifact: () => (sessions.get(sessionID)?.plans.size ?? 0) > 0,
        planArtifactReferences: () =>
          [...(sessions.get(sessionID)?.plans.values() ?? [])].sort(
            (a, b) => b.count - a.count || b.lastTouchedAt - a.lastTouchedAt,
          ),
      }
    },
    close,
  }
}
