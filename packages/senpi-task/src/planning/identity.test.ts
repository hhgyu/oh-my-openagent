import { expect, test } from "bun:test"

import * as nativePlanner from "../../../omo-senpi/src/components/task/planner"
import * as nativePin from "../../../omo-senpi/src/components/task/planner-explicit-pin"
import * as nativeFast from "../../../omo-senpi/src/components/task/fast-mode-inheritance"
import * as nativeErrors from "../../../omo-senpi/src/components/task/model-error-text"
import * as planner from "./child-planner"
import * as pin from "./explicit-pin"
import * as fast from "./fast-mode-inheritance"
import * as errors from "./model-error-text"
import type { ParentServiceTier as NativeTier } from "../../../omo-senpi/src/components/task/runtime-context"
import type { ParentServiceTier } from "./types"

const nativeTier: NativeTier = "priority"
const movedTier: ParentServiceTier = nativeTier

test("Native planner paths retain every original runtime export with the same function identity", () => {
  expect(nativePlanner.createTaskChildPlanner).toBe(planner.createTaskChildPlanner)
  expect(nativePin.resolveExplicitPin).toBe(pin.resolveExplicitPin)
  expect(nativePin.NO_REGISTRY_MESSAGE).toBe(pin.NO_REGISTRY_MESSAGE)
  expect(nativeFast.inheritParentFastMode).toBe(fast.inheritParentFastMode)
  expect(nativeErrors.chainUnavailableText).toBe(errors.chainUnavailableText)
  expect(nativeErrors.pinnedModelUnavailableText).toBe(errors.pinnedModelUnavailableText)
  expect(nativeErrors.categoryModelFailureText).toBe(errors.categoryModelFailureText)
  expect(nativeErrors.agentModelFailureText).toBe(errors.agentModelFailureText)
  expect(movedTier).toBe("priority")
})

test("moved operation accepts a real minimal identity catalog with receiver-bound lookup and no Native model runtime", () => {
  const model = { provider: "local", id: "exact" }
  const registry = {
    entries: [model],
    getAvailable() { return this.entries },
    find(provider: string, id: string) { return this.entries.find((entry) => entry.provider === provider && entry.id === id) },
  }
  const plan = planner.createTaskChildPlanner({}, {}, () => registry)({ prompt: "inspect", parent_session_id: "parent", depth: 0, model: "local/exact:high" })
  expect(plan).toEqual({ kind: "resolved", plan: { model: "local/exact", resolved_model: { source: "explicit", provider: "local", model_id: "exact", display: "local/exact:high", reasoning: "high" }, variant: "high" } })
})
