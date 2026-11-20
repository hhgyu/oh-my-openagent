import { describe, expect, test } from "bun:test"
import { adaptResearchCollectionForV2 } from "./research-collection-adaptation"

const NATIVE_MASS = "**When the user asked for MASS research, the team is not the collection surface.** native text"
const SHARED_MASS =
  "**When the user asked for MASS research, the wave is sized by the topic's angles, not by the roster.** shared text"
const NATIVE_ASK_ONE = "ask in one `ask_user_question` call with `waitForAnswer: false`, each with its default"
const NATIVE_ASK_TWO = "in the same `ask_user_question` call as the format questions, with `waitForAnswer: false`, each"

const nativeFixture = ["head", NATIVE_ASK_ONE, NATIVE_ASK_TWO, NATIVE_MASS, "tail"].join("\n")
const sharedFixture = ["other", SHARED_MASS, "more"].join("\n")

describe("research-collection adaptation for V2", () => {
  test("#given the Native reference #when adapted #then the MASS paragraph is the shared one and no Native-only question call remains", () => {
    // given the fixtures above
    // when
    const lines = adaptResearchCollectionForV2(nativeFixture, sharedFixture).split("\n")

    // then
    expect(lines).toHaveLength(5)
    expect(lines[0]).toBe("head")
    expect(lines[3]?.startsWith(SHARED_MASS)).toBe(true)
    expect(lines[4]).toBe("tail")
    expect(lines.join("\n")).not.toContain("waitForAnswer")
    expect(lines.join("\n")).not.toContain(NATIVE_MASS)
  })

  test("#given an anchor that drifted #when adapted #then it throws instead of shipping the Native text", () => {
    // given a Native text without the MASS paragraph, a shared text without it, and a Native text without the question call
    const noNativeMass = nativeFixture.replace(NATIVE_MASS, "x")
    const noQuestionCall = nativeFixture.replace(NATIVE_ASK_ONE, "x")

    // when then
    expect(() => adaptResearchCollectionForV2(noNativeMass, sharedFixture)).toThrow("Native anchor")
    expect(() => adaptResearchCollectionForV2(nativeFixture, "other")).toThrow("shared anchor")
    expect(() => adaptResearchCollectionForV2(noQuestionCall, sharedFixture)).toThrow("drifted")
  })
})
