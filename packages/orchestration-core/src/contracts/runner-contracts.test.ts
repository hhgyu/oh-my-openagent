import { expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { RunnerError, isTaskStartFailureKind, isTaskStartFailureReason } from "../index"
import { RunnerError as DirectRunnerError } from "./runner-error"
import { TASK_START_FAILURE_KINDS, TASK_START_FAILURE_REASONS } from "./task-start-failure"
import type { ChildCompletionPolicy, RunnerFailure, RunnerOutcome, TaskInterruptCause } from "./child-outcome"

function present<T>(value: T | null | undefined): T {
  if (value === null || value === undefined) throw new Error("expected value to be present")
  return value
}

test("public barrel and direct contract share the original branded constructor and cause", () => {
  const cause = new Error("fixture cause")
  const failure: RunnerFailure = { kind: "child-prompt-failed", message: "fixture failed", cause }
  const error = new RunnerError(failure)
  expect(RunnerError).toBe(DirectRunnerError)
  expect(DirectRunnerError.is(error)).toBe(true)
  expect(error.name).toBe("RunnerError")
  expect(error.message).toBe(failure.message)
  expect(error.failure).toBe(failure)
  expect(error.cause).toBe(cause)
  expect(new RunnerError({ kind: "depth-exceeded", message: "depth" }).cause).toBeUndefined()
})

test("prototype/name spoofs and revoked proxies cannot manufacture a runner failure brand", () => {
  const revoked = Proxy.revocable({}, {})
  revoked.revoke()
  for (const value of [
    null,
    undefined,
    false,
    "RunnerError",
    new Error("RunnerError"),
    { name: "RunnerError", failure: { kind: "model_unavailable", message: "spoof" } },
    Object.create(RunnerError.prototype),
    revoked.proxy,
  ])
    expect(RunnerError.is(value)).toBe(false)
  const real = new RunnerError({ kind: "model_unavailable", message: "real" })
  expect(RunnerError.is(new Proxy(real, {}))).toBe(false)
  real.name = "different diagnostic name"
  expect(RunnerError.is(real)).toBe(true)
})

test("closed enum validators reject inherited/nonstring selectors and retain every published member", () => {
  for (const kind of TASK_START_FAILURE_KINDS) expect(isTaskStartFailureKind(kind)).toBe(true)
  for (const reason of TASK_START_FAILURE_REASONS) expect(isTaskStartFailureReason(reason)).toBe(true)
  for (const value of ["constructor", "__proto__", "toString", "new_host_failure", {}, [], 1, null, undefined]) {
    expect(isTaskStartFailureKind(value)).toBe(false)
    expect(isTaskStartFailureReason(value)).toBe(false)
  }
})

test("all runner wire outcomes retain Native spellings and optional exit/interruption facts", () => {
  const cause: TaskInterruptCause = "session_replaced"
  const policies: readonly ChildCompletionPolicy[] = ["final-text", "turn"]
  const outcomes = [
    { status: "completed", finalResponse: "answer", model: "provider/model" },
    {
      status: "error",
      killed: true,
      model: "provider/model",
      failure: {
        kind: "child-turn-failed",
        message: "failed",
        reason: "open_timed_out",
        rejected_while: "exited",
        exit: { kind: "crashed", code: 1, signal: "SIGTERM" },
      },
    },
    { status: "cancelled" },
    { status: "interrupted", cause, message: "replaced", finalResponse: "partial", abortedBy: "user" },
  ] satisfies readonly RunnerOutcome[]
  expect(JSON.parse(JSON.stringify(outcomes))).toEqual(outcomes)
  expect(policies).toEqual(["final-text", "turn"])
  expect(outcomes[3]).toMatchObject({ status: "interrupted", cause: "session_replaced", finalResponse: "partial" })
})

test("implemented core contract closure has only explicit local imports and no harness dependency", () => {
  const files = ["../index.ts", "task-start-failure.ts", "child-outcome.ts", "runner-error.ts"]
  for (const file of files) {
    const source = readFileSync(new URL(file, import.meta.url), "utf8")
    const imports = [...source.matchAll(/(?:import|export)\s+(?:type\s+)?[\s\S]*?from\s*["']([^"']+)["']/g)].map(
      (match) => present(match[1]),
    )
    expect(imports.every((specifier) => specifier.startsWith("."))).toBe(true)
    expect(source).not.toMatch(/@code-yeongyu\/senpi|@opencode\/|@opencode-ai\/|senpi-barrel/)
  }
})
