#!/usr/bin/env node
// QA-local provider for task-id-race-qa.mjs. Unlike the shared provider, its script is
// process-private so two parent harnesses can use one project cwd without sharing input.
import { readFileSync } from "node:fs"
import { isAbsolute } from "node:path"

import { waitForGoFile } from "./task-id-race-gate.mjs"

const model = {
  id: "mock-1",
  name: "Mock 1",
  reasoning: false,
  input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 200_000,
  maxTokens: 4096,
}

let callCount = 0
let gateUsed = false

export default function registerTaskIdRaceMockProvider(pi) {
  pi.registerProvider("omo-mock", {
    name: "omo task-id race mock provider",
    baseUrl: "file://task-id-race-mock-provider",
    apiKey: "mock",
    api: "openai-completions",
    models: [model],
    streamSimple(_model, _context, options) {
      return streamMockResponse(options)
    },
  })
}

function loadMockScript() {
  const scriptPath = process.env.SENPI_QA_MOCK_SCRIPT
  if (typeof scriptPath !== "string" || !isAbsolute(scriptPath)) {
    throw new Error("SENPI_QA_MOCK_SCRIPT must be an absolute path")
  }
  const parsed = JSON.parse(readFileSync(scriptPath, "utf8"))
  if (!isMockScript(parsed)) throw new Error(`${scriptPath} must contain valid mock steps`)
  return parsed
}

function streamMockResponse(options) {
  const stream = createStream()
  const script = loadMockScript()
  const step = script.steps[Math.min(callCount, script.steps.length - 1)]
  callCount += 1
  const message = stepToAssistantMessage(step, callCount)

  queueMicrotask(async () => {
    try {
      if (!gateUsed) {
        gateUsed = true
        await waitForGoFile()
      }
      if (options?.signal?.aborted) {
        const aborted = { ...message, stopReason: "aborted" }
        stream.push({ type: "error", reason: "aborted", error: aborted })
        stream.end(aborted)
        return
      }
      stream.push({ type: "start", partial: { ...message, content: [] } })
      if (step.type === "text") {
        const partial = { ...message, content: [{ type: "text", text: "" }] }
        stream.push({ type: "text_start", contentIndex: 0, partial })
        stream.push({ type: "text_delta", contentIndex: 0, delta: step.text, partial: message })
        stream.push({ type: "text_end", contentIndex: 0, content: step.text, partial: message })
      } else {
        const toolCall = message.content[0]
        stream.push({ type: "toolcall_start", contentIndex: 0, partial: { ...message, content: [] } })
        stream.push({
          type: "toolcall_delta",
          contentIndex: 0,
          delta: JSON.stringify(step.arguments),
          partial: message,
        })
        stream.push({ type: "toolcall_end", contentIndex: 0, toolCall, partial: message })
      }
      stream.push({ type: "done", reason: message.stopReason, message })
      stream.end(message)
    } catch (error) {
      stream.fail(error instanceof Error ? error : new Error(String(error)))
    }
  })
  return stream
}

function isMockScript(value) {
  return typeof value === "object" && value !== null && Array.isArray(value.steps) && value.steps.every(isMockStep)
}

function isMockStep(value) {
  if (typeof value !== "object" || value === null) return false
  if (value.type === "text") return typeof value.text === "string"
  return (
    value.type === "tool_call" &&
    typeof value.name === "string" &&
    typeof value.arguments === "object" &&
    value.arguments !== null
  )
}

function stepToAssistantMessage(step, callNumber) {
  const content =
    step.type === "text"
      ? [{ type: "text", text: step.text }]
      : [{ type: "toolCall", id: step.id ?? `omo-race-tool-${callNumber}`, name: step.name, arguments: step.arguments }]
  return {
    role: "assistant",
    content,
    api: "openai-completions",
    provider: "omo-mock",
    model: "mock-1",
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: 0 },
    stopReason: step.type === "tool_call" ? "toolUse" : "stop",
    timestamp: Date.now(),
  }
}

function createStream() {
  const queue = []
  const waiters = []
  let done = false
  let settleResult = () => {}
  let rejectResult = () => {}
  const result = new Promise((resolve, reject) => {
    settleResult = resolve
    rejectResult = reject
  })
  result.catch(() => {})
  const drain = () => {
    while (waiters.length > 0) waiters.shift()({ value: undefined, done: true })
  }
  return {
    push(event) {
      if (done) return
      const waiter = waiters.shift()
      if (waiter) waiter({ value: event, done: false })
      else queue.push(event)
    },
    end(message) {
      if (done) return
      done = true
      settleResult(message)
      drain()
    },
    fail(error) {
      if (done) return
      done = true
      rejectResult(error)
      drain()
    },
    result: () => result,
    [Symbol.asyncIterator]() {
      return {
        next() {
          if (queue.length > 0) return Promise.resolve({ value: queue.shift(), done: false })
          if (done) return Promise.resolve({ value: undefined, done: true })
          return new Promise((resolve) => waiters.push(resolve))
        },
      }
    },
  }
}
