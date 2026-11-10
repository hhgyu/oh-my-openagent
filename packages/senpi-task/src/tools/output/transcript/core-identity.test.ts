import { expect, test } from "bun:test"
import * as Core from "@oh-my-opencode/orchestration-core"
import * as Reader from "./event-log"
import * as Bounded from "./read-bounded"
import * as Render from "../render"
import * as Writer from "../../../manager/transcript-log"
import { appendFileSync, mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createTaskRecordStore } from "../../../store"
import { makeRecord } from "../__fixtures__/records"
import type { ManagedChildEvent, ManagedChildHandle } from "../../../manager/child-handle"

test("Native old reader/render paths forward the same Core callable identities", () => {
  expect(Reader.readEventLogTranscript).toBe(Core.readEventLogTranscript)
  expect(Reader.readEventLogTranscriptResult).toBe(Core.readEventLogTranscriptResult)
  expect(Bounded.readBoundedFileText).toBe(Core.readBoundedFileText)
  expect(Render.renderTranscript).toBe(Core.renderTranscript)
  expect(Bounded.MAX_TRANSCRIPT_SOURCE_BYTES).toBe(Core.MAX_TRANSCRIPT_SOURCE_BYTES)
  expect(Render.TRANSCRIPT_MAX_CHARS).toBe(Core.TRANSCRIPT_MAX_CHARS)
  expect(Writer.TRANSCRIPT_ASSISTANT_EVENT).toBe(Core.TRANSCRIPT_ASSISTANT_EVENT)
  expect(Writer.TRANSCRIPT_TOOL_EVENT).toBe(Core.TRANSCRIPT_TOOL_EVENT)
  expect(Writer.TRANSCRIPT_ERROR_EVENT).toBe(Core.TRANSCRIPT_ERROR_EVENT)
})

test("Native subscription projects through Core into real redacting store and shared reader/render", () => {
  const dir = mkdtempSync(join(tmpdir(), "senpi-core-transcript-"))
  const store = createTaskRecordStore({ project_dir: dir, task: { state_dir: dir } })
  const taskId = "st_000000ef"
  let listener: ((event: ManagedChildEvent) => void) | undefined
  let detached = false
  try {
    const handle = { subscribe(next: typeof listener) { listener = next; return () => { detached = true; listener = undefined } } } as unknown as ManagedChildHandle
    const unsubscribe = Writer.subscribeTranscriptLog(handle, store, taskId)
    listener?.({ type: "message_end", message: { role: "assistant", stopReason: "aborted", content: [{ type: "text", text: "partial work" }] } })
    listener?.({ type: "message_end", message: { role: "assistant", stopReason: "error", errorMessage: "provider failure", content: [{ type: "text", text: "error prose excluded" }] } })
    listener?.({ type: "tool_execution_end", toolName: "read", isError: true })
    listener?.({ type: "retry_fallback_exhausted", ...{ chainKey: "chain", lastError: "failure audit" } })
    store.appendEvent(taskId, { type: "team_message_waited", payload: { from: "alpha", body: "waited message" } })
    store.appendEvent(taskId, { type: "state_changed", payload: { text: "lifecycle hidden" } })
    appendFileSync(join(dir, "logs", `${taskId}.jsonl`), "malformed\n")
    unsubscribe()
    expect(detached).toBe(true)
    expect(Reader.readEventLogTranscriptResult(dir, taskId)).toEqual({ source: "event-log", truncated: false, entries: [
      { kind: "assistant", text: "partial work" }, { kind: "error", message: "provider failure" },
      { kind: "tool", tool: "read", is_error: true }, { kind: "assistant", text: "[team message from alpha] waited message" },
    ] })
    const display = Render.renderTranscript(Reader.readEventLogTranscript(dir, taskId), { mode: "full", tailLines: 60 })
    expect(display.text).toContain("assistant: partial work")
    expect(display.text).toContain("error: provider failure")
    expect(display.text).toContain("tool[error]: read")
    expect(display.text).not.toContain("error prose excluded")
    expect(display.text).not.toContain("lifecycle hidden")
    expect(readFileSync(join(dir, "logs", `${taskId}.jsonl`), "utf8")).toContain('"retry_fallback_exhausted"')
  } finally { store.remove(taskId); rmSync(dir, { recursive: true, force: true }) }
})

test("Native model mutation remains before Core projection and append", () => {
  const dir = mkdtempSync(join(tmpdir(), "senpi-core-model-order-"))
  const store = createTaskRecordStore({ project_dir: dir, task: { state_dir: dir } })
  const taskId = "st_000000ee"
  try {
    store.save(makeRecord({ task_id: taskId, model: "alpha/one", resolved_model: { source: "category", provider: "alpha", model_id: "one", display: "alpha/one" } }))
    const models: (string | undefined)[] = []
    const event = { type: "retry_fallback_applied", from: "alpha/one", chainKey: "chain", reason: "retry",
      get to() { models.push(store.load(taskId)?.model); return "beta/two" },
    }
    Writer.logTranscriptEvent({ ...store, appendEvent(id, projected) {
      expect(store.load(taskId)?.model).toBe("beta/two")
      return store.appendEvent(id, projected)
    } }, taskId, event)
    expect(models).toEqual(["alpha/one", "beta/two"])
    expect(store.load(taskId)?.resolved_model?.display).toBe("beta/two")
    expect(JSON.parse(readFileSync(join(dir, "logs", `${taskId}.jsonl`), "utf8"))).toEqual({
      type: "retry_fallback_applied", payload: { from: "alpha/one", to: "beta/two", chain_key: "chain", reason: "retry" },
    })
    expect(Reader.readEventLogTranscript(dir, taskId)).toEqual([])
  } finally { store.remove(taskId); rmSync(dir, { recursive: true, force: true }) }
})
