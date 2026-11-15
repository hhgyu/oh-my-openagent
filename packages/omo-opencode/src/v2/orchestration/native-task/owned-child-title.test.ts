import { describe, expect, test } from "bun:test"
import { OWNED_CHILD_TITLE_MAX, ownedChildTitle } from "./owned-child-title"

describe("ownedChildTitle", () => {
  test("#given a task summary #when titled #then the summary leads and the task id follows", () => {
    // given
    const record = { task_summary: "Title probe A", description: "ignored description", name: "ignored-name" }

    // when
    const title = ownedChildTitle("st_0123abcd", record)

    // then
    expect(title).toBe("Title probe A (st_0123abcd)")
  })

  test("#given only a description #when titled #then the description is used", () => {
    // given
    const record = { description: "Title probe B", name: "ignored-name" }

    // when
    const title = ownedChildTitle("st_0123abcd", record)

    // then
    expect(title).toBe("Title probe B (st_0123abcd)")
  })

  test("#given only a name #when titled #then the name is used", () => {
    // given
    const record = { name: "worker-1" }

    // when
    const title = ownedChildTitle("st_0123abcd", record)

    // then
    expect(title).toBe("worker-1 (st_0123abcd)")
  })

  test("#given blank or missing labels #when titled #then the Native task fallback is kept", () => {
    // given
    const blank = { task_summary: " \t\n ", description: "\u001b[31m\u001b[0m", name: "" }

    // when
    const titles = [
      ownedChildTitle("st_0123abcd", blank),
      ownedChildTitle("st_0123abcd", undefined),
      ownedChildTitle("st_0123abcd", { name: "st_0123abcd" }),
    ]

    // then
    expect(titles).toEqual(["Native task st_0123abcd", "Native task st_0123abcd", "Native task st_0123abcd"])
  })

  test("#given whitespace runs and control characters #when titled #then they are collapsed and stripped", () => {
    // given
    const record = { task_summary: "  Fix\n\tthe \u0007 \u001b[1mparser\u001b[0m\r\n bug  " }

    // when
    const title = ownedChildTitle("st_0123abcd", record)

    // then
    expect(title).toBe("Fix the parser bug (st_0123abcd)")
  })

  test("#given an oversized summary #when titled #then it is bounded with the id suffix intact", () => {
    // given
    const record = { task_summary: `${"word ".repeat(400)}tail`, description: "x".repeat(5000) }

    // when
    const title = ownedChildTitle("st_0123abcd", record)

    // then
    expect(title.length).toBeLessThanOrEqual(OWNED_CHILD_TITLE_MAX)
    expect(title.endsWith("... (st_0123abcd)")).toBe(true)
    expect(title.startsWith("word word")).toBe(true)
  })

  test("#given astral characters at the cut #when titled #then no surrogate pair is split", () => {
    // given
    const record = { task_summary: "\u{1F600}".repeat(200) }

    // when
    const title = ownedChildTitle("st_0123abcd", record)

    // then
    expect(title.length).toBeLessThanOrEqual(OWNED_CHILD_TITLE_MAX)
    expect(title.isWellFormed()).toBe(true)
    expect(title.endsWith("... (st_0123abcd)")).toBe(true)
  })
})
