import type { ThreadSummary } from "@oh-my-opencode/thread-core/contracts"
import { refuse, type SessionControl } from "@oh-my-opencode/thread-core/control/port"
import type { ThreadTranscriptEntry } from "@oh-my-opencode/thread-core/reader"
import { createModelCatalog } from "../host/model-catalog"
import {
  THREAD_CLOSED_METADATA_KEY,
  executionEpoch,
  isClosed,
  isExecuting,
  writeSessionMetadata,
  type ThreadV2Host,
  type V2SessionInfo,
} from "./host"
import { sessionTitle } from "./address-book"

/** Native reasoning levels; a session runs one only where its model advertises a host variant of that name. */
const THINKING_LEVELS: ReadonlySet<string> = new Set(["off", "minimal", "low", "medium", "high", "xhigh", "max"])

const CLOSE_SETTLE_MS = 10_000

function transcriptEntry(message: Record<string, unknown>): ThreadTranscriptEntry {
  const type = message["type"]
  const role = type === "user" || type === "assistant" ? type : type === "shell" ? "toolResult" : "system"
  const content =
    type === "assistant" ? message["content"] : (message["text"] ?? message["summary"] ?? message["command"] ?? null)
  const time = message["time"] as { readonly created?: unknown } | undefined
  return JSON.parse(
    JSON.stringify({
      id: message["id"] ?? null,
      timestamp: typeof time?.created === "number" ? new Date(time.created).toISOString() : null,
      role,
      content: content ?? null,
    }),
  ) as ThreadTranscriptEntry
}

export function createV2SessionControl(input: {
  readonly host: Pick<ThreadV2Host, "session" | "model" | "provider">
  readonly info: V2SessionInfo
  readonly visible: () => Promise<readonly ThreadSummary[]>
}): SessionControl {
  const { host } = input
  const sessionID = input.info.id
  const catalog = createModelCatalog({ model: host.model, provider: host.provider })
  const current = () => host.session.get({ sessionID })
  // An interrupt is acknowledged before the execution ends; the close is recorded once the session is quiet.
  async function settledOrTimeout(): Promise<void> {
    const deadline = Date.now() + CLOSE_SETTLE_MS
    while (Date.now() < deadline) {
      if (!isExecuting(await current())) return
      await new Promise((resolve) => setTimeout(resolve, 100))
    }
  }

  async function activeModel() {
    const info = await current()
    if (info.model === undefined)
      throw refuse("unsupported", "The session has no model selected yet.", "Set a model with thread_set_model first.")
    const models = await catalog.list()
    const entry = models.find((model) => model.providerID === info.model?.providerID && model.id === info.model?.id)
    return { info, model: info.model, variants: entry?.reasoning.variants ?? [] }
  }

  return {
    thread_id: sessionID,
    title: sessionTitle(input.info),
    visible: input.visible,
    async interrupt(turnId) {
      const info = await current()
      const epoch = String(executionEpoch(info))
      if (!isExecuting(info) || (turnId !== undefined && turnId !== epoch)) return { interrupted: false }
      const reply = await host.session.interrupt({ sessionID, resume: false })
      return { interrupted: reply.interrupted, turn_id: epoch }
    },
    async close() {
      const info = await current()
      if (isClosed(info)) return "not_live"
      if (isExecuting(info)) {
        await host.session.interrupt({ sessionID, resume: false })
        await settledOrTimeout()
      }
      await writeSessionMetadata(host.session, sessionID, THREAD_CLOSED_METADATA_KEY, new Date().toISOString())
      return "closed"
    },
    async setName(name) {
      await host.session.update({ sessionID, title: name })
    },
    async getAvailableModels() {
      const models = await catalog.list()
      return {
        models: models.map((model) => ({ provider: model.providerID, id: model.id, name: model.name })),
        held: false,
      }
    },
    async setModel(provider, id) {
      await host.session.switchModel({ sessionID, model: { providerID: provider, id } })
      return { provider, id }
    },
    async getAvailableThinkingLevels() {
      return (await activeModel()).variants.filter((variant) => THINKING_LEVELS.has(variant))
    },
    async setThinkingLevel(level) {
      const { model, variants } = await activeModel()
      if (!variants.includes(level))
        throw refuse(
          "thinking_level_unsupported",
          `Thinking level "${level}" is not an advertised variant of ${model.providerID}/${model.id}.`,
          "Choose a level from the supported list and retry.",
        )
      await host.session.switchModel({
        sessionID,
        model: { providerID: model.providerID, id: model.id, variant: level },
      })
    },
    async getMessages() {
      const messages = await host.session.context({ sessionID })
      return messages.map((message) => transcriptEntry(message as unknown as Record<string, unknown>))
    },
  }
}
