import { afterEach, expect, test } from "bun:test"
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { ManagedChildEvent } from "../contracts/child-event"
import type { ProjectedTranscriptEvent, TranscriptReader } from "../contracts/transcript"
import * as Public from "../index"
import { toPersistedEvent } from "./events"
import { readEventLogTranscript, readEventLogTranscriptResult } from "./event-log"
import { MAX_TRANSCRIPT_SOURCE_BYTES, readBoundedFileText } from "./read-bounded"
import { renderTranscript, TRANSCRIPT_MAX_CHARS } from "./render"

function present<T>(value: T | null | undefined): T {
  if (value === null || value === undefined) throw new Error("expected value to be present")
  return value
}

const dirs: string[] = []
function directory() {
  const dir = mkdtempSync(join(tmpdir(), "omo-core-transcript-"))
  dirs.push(dir)
  return dir
}
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})
const assistant = (text: string, stopReason = "stop", errorMessage?: string): ManagedChildEvent => ({
  type: "message_end",
  message: { role: "assistant", content: [{ type: "text", text }], stopReason, errorMessage },
})

test("neutral producer projection roundtrips real own-log file and display semantics", () => {
  const dir = directory()
  mkdirSync(join(dir, "logs"))
  const path = join(dir, "logs", "task.jsonl")
  for (const event of [
    assistant("partial aborted prose", "aborted"),
    assistant("hidden failed prose", "error", "provider breadcrumb"),
    { type: "tool_execution_end", toolName: "read", isError: true },
    { type: "lifecycle" },
  ]) {
    const projected = toPersistedEvent(event)
    if (projected) appendFileSync(path, JSON.stringify(projected) + "\n")
  }
  appendFileSync(path, 'malformed\nnull\n{}\n{"type":"lifecycle","payload":{}}\n')
  appendFileSync(
    path,
    JSON.stringify({ type: "team_message_waited", payload: { from: "alpha", body: "durable body" } }) + "\n",
  )
  const read: TranscriptReader = ({ stateDir, taskId }) => readEventLogTranscriptResult(stateDir, taskId)
  const result = read({ stateDir: dir, taskId: "task" })
  expect(result).toEqual({
    source: "event-log",
    truncated: false,
    entries: [
      { kind: "assistant", text: "partial aborted prose" },
      { kind: "error", message: "provider breadcrumb" },
      { kind: "tool", tool: "read", is_error: true },
      { kind: "assistant", text: "[team message from alpha] durable body" },
    ],
  })
  expect(renderTranscript(result.entries, { mode: "full", tailLines: 60 })).toEqual({
    text: "assistant: partial aborted prose\nerror: provider breadcrumb\ntool[error]: read\nassistant: [team message from alpha] durable body",
    truncated: false,
  })
  expect(renderTranscript(result.entries, { mode: "tail", tailLines: 1 })).toEqual({
    text: "assistant: [team message from alpha] durable body",
    truncated: true,
  })
})

test("both retry audit payloads retain exact keys and undefined values without becoming transcript prose", () => {
  const applied = { type: "retry_fallback_applied", from: "a/one", to: "b/two", chainKey: "chain", reason: "retry" }
  expect(toPersistedEvent(applied)).toEqual({
    type: applied.type,
    payload: { from: "a/one", to: "b/two", chain_key: "chain", reason: "retry" },
  })
  expect(toPersistedEvent({ type: applied.type })).toEqual({
    type: applied.type,
    payload: { from: undefined, to: undefined, chain_key: undefined, reason: undefined },
  })
  const exhausted = { type: "retry_fallback_exhausted", chainKey: "chain", lastError: "exhausted" }
  expect(toPersistedEvent(exhausted)).toEqual({
    type: "retry_fallback_exhausted",
    payload: { chain_key: "chain", last_error: "exhausted" },
  })
  expect(toPersistedEvent({ type: "retry_fallback_exhausted" })).toEqual({
    type: "retry_fallback_exhausted",
    payload: { chain_key: undefined, last_error: undefined },
  })
  const dir = directory()
  mkdirSync(join(dir, "logs"))
  writeFileSync(join(dir, "logs/task.jsonl"), JSON.stringify(toPersistedEvent(applied)))
  expect(readEventLogTranscript(dir, "task")).toEqual([])
})

test("projection preserves filtering, multipart concatenation and error-only breadcrumb fallback", () => {
  for (const message of [
    null,
    [],
    { role: "user", content: [{ type: "text", text: "not assistant" }] },
    { role: "assistant", content: [{ type: "toolCall", text: "hidden" }] },
    { role: "assistant", content: [{ type: "text", text: "" }] },
  ]) {
    expect(toPersistedEvent({ type: "message_end", message })).toBeUndefined()
  }
  expect(toPersistedEvent({ type: "tool_execution_end", toolName: undefined })).toBeUndefined()
  expect(toPersistedEvent({ type: "tool_execution_start", toolName: "read" })).toBeUndefined()
  expect(toPersistedEvent({ type: "tool_execution_end", toolName: "read" })).toEqual({
    type: "tool_execution",
    payload: { tool: "read", is_error: false },
  })
  expect(
    toPersistedEvent({
      type: "message_end",
      message: {
        role: "assistant",
        content: [
          { type: "text", text: "one" },
          { type: "thinking", text: "private" },
          { type: "text", text: "two" },
        ],
      },
    }),
  ).toEqual({ type: "assistant_message", payload: { text: "onetwo" } })
  expect(toPersistedEvent(assistant("", "error", ""))).toEqual({
    type: "child_error",
    payload: { message: "child turn failed without a diagnostic message", stop_reason: "error" },
  })
})

test("bounded source and character/tail defaults preserve original head-tail behavior", () => {
  const dir = directory()
  const path = join(dir, "large")
  expect(readBoundedFileText(path)).toBeUndefined()
  expect(readEventLogTranscriptResult(dir, "missing")).toEqual({ entries: [], source: "event-log", truncated: false })
  writeFileSync(path, "abcdefghijk")
  expect(readBoundedFileText(path, 7)).toEqual({ text: "abc\nijk", truncated: true })
  writeFileSync(path, "a".repeat(MAX_TRANSCRIPT_SOURCE_BYTES) + "MIDDLE" + "z".repeat(MAX_TRANSCRIPT_SOURCE_BYTES))
  const bounded = present(readBoundedFileText(path))
  expect(Buffer.byteLength(bounded.text)).toBe(MAX_TRANSCRIPT_SOURCE_BYTES)
  expect(bounded.truncated).toBe(true)
  expect(bounded.text).not.toContain("MIDDLE")
  const rendered = renderTranscript([{ kind: "assistant", text: "x".repeat(TRANSCRIPT_MAX_CHARS * 2) }], {
    mode: "full",
    tailLines: 60,
  })
  expect(rendered.truncated).toBe(true)
  expect(rendered.text.length).toBeLessThanOrEqual(TRANSCRIPT_MAX_CHARS)
  expect(rendered.text).toContain("elided")
  expect(renderTranscript([], { mode: "full", tailLines: 60 })).toEqual({
    text: "(no transcript recorded for this task)",
    truncated: false,
  })
  // Characterize existing zero-tail behavior without changing it during extraction.
  expect(renderTranscript([{ kind: "assistant", text: "kept" }], { mode: "tail", tailLines: 0 })).toEqual({
    text: "assistant: kept",
    truncated: true,
  })
})

test("implemented public exports are same functions and complete closure has no harness imports", () => {
  expect(Public.toPersistedEvent).toBe(toPersistedEvent)
  expect(Public.readEventLogTranscript).toBe(readEventLogTranscript)
  expect(Public.renderTranscript).toBe(renderTranscript)
  const files = [
    "../contracts/child-event.ts",
    "../contracts/transcript.ts",
    "events.ts",
    "event-log.ts",
    "read-bounded.ts",
    "render.ts",
  ]
  for (const file of files) {
    const source = readFileSync(new URL(file, import.meta.url), "utf8")
    const imports = [
      ...source.matchAll(
        /^(?:import|export)\s+(?:type\s+)?(?:\{[^}]*\}|\*(?:\s+as\s+\w+)?|[\w$]+)\s+from\s*["']([^"']+)["']/gm,
      ),
    ].map((match) => present(match[1]))
    expect(imports.every((specifier) => specifier.startsWith(".") || specifier.startsWith("node:"))).toBe(true)
    expect(source).not.toMatch(/\b(?:import\s*\(|require\s*\()/)
    expect(source).not.toMatch(/@code-yeongyu\/senpi|@opencode\/|@opencode-ai\/|senpi-task|omo-senpi|senpi-barrel/)
  }
  const shape: ProjectedTranscriptEvent = { type: "structural-only", payload: undefined }
  expect(shape).toEqual({ type: "structural-only", payload: undefined })
})
