import { createHash } from "node:crypto"
import { closeSync, existsSync, fsyncSync, openSync, readFileSync, statSync } from "node:fs"
import { join } from "node:path"
import { toPersistedEvent } from "@oh-my-opencode/orchestration-core/transcript/events"
import {
  withTaskRecordLock,
  ChildObservationUncertain,
  type ManagedChildEvent,
} from "@oh-my-opencode/senpi-task/manager-kernel"
import type { OwnedChildObservationView } from "../../host/owned-child-observation-types"

type Sink = { appendEvent(taskId: string, event: { type: string; payload: unknown }): string }
/** Own display-log framing; these are normalized OmO events, never SDK session history. */
export function createOwnedEventProjection(
  taskId: string,
  epoch: number,
  stateDir: string,
  assertOwned: () => void,
  maximumLogBytes = 16_777_216,
) {
  if (!Number.isSafeInteger(maximumLogBytes) || maximumLogBytes < 1)
    throw new Error("Invalid owned projection log bound")
  const identities = new WeakMap<object, string>()
  let cachedSignature: string | undefined
  let persisted = new Set<string>()
  const signature = (path: string) => {
    const info = statSync(path)
    if (info.size > maximumLogBytes) throw new ChildObservationUncertain("own-log-capacity-exceeded")
    return `${info.ino}:${info.size}:${info.mtimeMs}`
  }
  function frame(event: ManagedChildEvent, recordID: string) {
    identities.set(event, recordID)
    return event
  }
  function events(view: OwnedChildObservationView): readonly ManagedChildEvent[] {
    const own = new Set(view.records.filter((row) => row.kind === "input").map((row) => row.inboxID))
    const steps = new Map<
      string,
      { owned: boolean; model: { providerID: string; id: string }; parts: Map<number, string> }
    >()
    // A run the session starts on its own after an owned one (a background job's notice) continues
    // that turn, so its output is shown too (omo#9069).
    let delivery = false,
      turnOpened = false
    const result: ManagedChildEvent[] = []
    for (const row of view.records) {
      if (row.kind !== "host") continue
      const event = row.event,
        data = event.data,
        id = data.assistantMessageID
      if (event.type === "session.execution.started") {
        delivery = turnOpened
        steps.clear()
      }
      if (event.type === "session.inbox.delivered" && data.inboxID && own.has(data.inboxID))
        delivery = turnOpened = true
      if (event.type === "session.step.started" && id && data.model) {
        steps.set(id, { owned: delivery, model: data.model, parts: new Map() })
        if (delivery)
          result.push(
            frame(
              {
                type: "message_start",
                message: { role: "assistant", provider: data.model.providerID, model: data.model.id },
              },
              row.id,
            ),
          )
      }
      const step = id ? steps.get(id) : undefined
      if (!step?.owned) continue
      if (event.type === "session.text.ended" && data.ordinal !== undefined && data.text !== undefined)
        step.parts.set(data.ordinal, data.text)
      if (event.type === "session.step.ended" || event.type === "session.step.failed") {
        const text = [...step.parts]
          .sort(([a], [b]) => a - b)
          .map(([, part]) => part)
          .join("")
        result.push(
          frame(
            {
              type: "message_end",
              message: {
                role: "assistant",
                provider: step.model.providerID,
                model: step.model.id,
                content: text ? [{ type: "text", text }] : [],
                stopReason:
                  event.type === "session.step.failed"
                    ? data.errorType === "aborted"
                      ? "aborted"
                      : "error"
                    : data.finish === "tool-calls"
                      ? "toolUse"
                      : data.finish,
                ...(data.errorType ? { errorMessage: data.errorType } : {}),
              },
            },
            row.id,
          ),
        )
      }
      if ((event.type === "session.tool.success" || event.type === "session.tool.failed") && data.callID) {
        const metadata = view.toolMetadata.joined.find(
          (item) => item.callID === data.callID && item.messageID === id && item.sessionID === event.sessionID,
        )
        if (metadata)
          result.push(
            frame(
              {
                type: "tool_execution_end",
                toolCallId: data.callID,
                toolName: metadata.tool,
                isError: metadata.status === "error",
              },
              row.id,
            ),
          )
      }
    }
    return result
  }
  function persist(store: Sink, event: ManagedChildEvent) {
    const projected = toPersistedEvent(event)
    if (!projected) return
    const recordID = identities.get(event)
    if (!recordID) throw new ChildObservationUncertain("missing-projection-identity")
    const projection = createHash("sha256").update(`${taskId}\0${epoch}\0${recordID}`).digest("hex")
    assertOwned()
    // Lock+scan reconciles an append whose checkpoint acknowledgement was lost. The projection
    // ID lives IN the own-log frame: no cross-SQLite/JSONL atomicity is claimed.
    withTaskRecordLock(join(stateDir, "tasks", `${taskId}.json`), () => {
      assertOwned()
      const path = join(stateDir, "logs", `${taskId}.jsonl`)
      if (existsSync(path)) {
        const observed = signature(path)
        if (cachedSignature !== observed) {
          const contents = readFileSync(path, "utf8")
          if (Buffer.byteLength(contents) > maximumLogBytes)
            throw new ChildObservationUncertain("own-log-capacity-exceeded")
          const next = new Set<string>()
          for (const line of contents.split("\n")) {
            try {
              const key = JSON.parse(line)?.payload?.__omo_projection
              if (typeof key === "string") next.add(key)
            } catch {
              if (line.trim()) throw new ChildObservationUncertain("torn-own-log-frame")
            }
          }
          persisted = next
          cachedSignature = observed
        }
        if (persisted.has(projection)) return
      } else {
        persisted.clear()
        cachedSignature = undefined
      }
      const payload = projected.payload as Record<string, unknown>
      const appended = store.appendEvent(taskId, {
        type: projected.type,
        payload: { ...payload, __omo_projection: projection },
      })
      const fd = openSync(appended, "r+")
      try {
        fsyncSync(fd)
      } finally {
        closeSync(fd)
      }
      persisted.add(projection)
      cachedSignature = signature(appended)
    })
  }
  return { events, persist, identity: (event: ManagedChildEvent) => identities.get(event) }
}
