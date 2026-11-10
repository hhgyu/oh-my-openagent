import { expect, test } from "bun:test"
import { RunnerError as CoreRunnerError } from "@oh-my-opencode/orchestration-core/contracts/runner-error"
import * as CoreFailure from "@oh-my-opencode/orchestration-core/contracts/task-start-failure"
import type { RunnerOutcome, TaskInterruptCause as CoreInterruptCause } from "@oh-my-opencode/orchestration-core/contracts/child-outcome"
import { RunnerError } from "./runner-error"
import { RunnerError as BarrelRunnerError } from "../in-process"
import * as NativeFailure from "../../state/start-failure"
import type { RunnerOutcome as NativeOutcome } from "./child-handle"
import type { TaskInterruptCause } from "../../state/record-types"
import { describeStartFailure } from "../../manager/start-failure"

test("old direct/barrel paths and core are exactly one RunnerError constructor", () => {
  expect(RunnerError).toBe(CoreRunnerError)
  expect(BarrelRunnerError).toBe(CoreRunnerError)
  const cause = new Error("owned fixture cause")
  const error = new CoreRunnerError({ kind: "model_unavailable", message: "unavailable", reason: "model_not_in_child_profile", cause })
  expect(RunnerError.is(error)).toBe(true)
  expect(BarrelRunnerError.is(error)).toBe(true)
  expect(error.cause).toBe(cause)
  expect(describeStartFailure(error)).toMatchObject({ failureKind: "model_unavailable", failureReason: "model_not_in_child_profile" })
})

test("Native failure constants and validators re-export the same values and functions", () => {
  expect(Object.keys(NativeFailure).sort()).toEqual(Object.keys(CoreFailure).sort())
  for (const name of Object.keys(CoreFailure) as (keyof typeof CoreFailure)[]) expect(NativeFailure[name]).toBe(CoreFailure[name])
  expect(NativeFailure.isTaskStartFailureKind("constructor")).toBe(false)
  expect(NativeFailure.isTaskStartFailureReason("__proto__")).toBe(false)
})

test("old outcome and interruption aliases accept the same exact wire contract", () => {
  const cause: TaskInterruptCause = "session_replaced"
  const coreCause: CoreInterruptCause = cause
  const core: RunnerOutcome = { status: "interrupted", cause: coreCause, finalResponse: "preserved partial", abortedBy: "user" }
  const native: NativeOutcome = core
  const back: RunnerOutcome = native
  expect(back).toBe(core)
  expect(JSON.parse(JSON.stringify(native))).toEqual({ status: "interrupted", cause: "session_replaced", finalResponse: "preserved partial", abortedBy: "user" })
})
