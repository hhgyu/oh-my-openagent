import { expect, test } from "bun:test"
import * as kernel from "./kernel-entry"
import { InputUncertainError } from "../runners/input-effects"

test("manager kernel forwards the canonical input uncertainty constructor", () => {
  expect((kernel as unknown as Record<string, unknown>).InputUncertainError).toBe(InputUncertainError)
})
