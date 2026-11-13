import { Agent } from "@opencode/plugin"
import type { AgentEditor } from "@opencode/plugin/promise/agent"

export function recordingEditor() {
  const entries = new Map<string, ReturnType<AgentEditor["list"]>[number]>()
  entries.set("build", Agent.Info.default(Agent.ID.make("build")))
  const editor: AgentEditor = {
    list: () => [...entries.values()],
    get: (id) => entries.get(id),
    default: () => {},
    remove: (id) => {
      entries.delete(id)
    },
    update: (id, callback) => {
      const agent = entries.get(id) ?? Agent.Info.default(Agent.ID.make(id))
      entries.set(id, agent)
      callback(agent)
    },
  }
  return { editor, entries }
}
