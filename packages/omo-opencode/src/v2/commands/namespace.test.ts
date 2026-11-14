import { describe, expect, test } from "bun:test"
import { NATIVE_COMMAND_NAMES, rewriteCommandMentions, v2CommandName, v2Slash } from "./namespace"

describe("V2 command namespace", () => {
  test("#given every Native command OmO registers on OpenCode 2 #when it is mapped #then its V2 name is omo:<native name>", () => {
    // given
    const native = [...NATIVE_COMMAND_NAMES]

    // when
    const mapped = Object.fromEntries(native.map((name) => [name, v2CommandName(name)]))

    // then
    expect(mapped).toEqual({
      memory: "omo:memory",
      memfs: "omo:memfs",
      remember: "omo:remember",
      init: "omo:init",
      recompile: "omo:recompile",
      "memory-repository": "omo:memory-repository",
      search: "omo:search",
      facts: "omo:facts",
      agreements: "omo:agreements",
      reflect: "omo:reflect",
      dream: "omo:dream",
      doctor: "omo:doctor",
      sleeptime: "omo:sleeptime",
      people: "omo:people",
      palace: "omo:palace",
      goal: "omo:goal",
      computer: "omo:computer",
    })
    expect(v2Slash("goal")).toBe("/omo:goal")
  })

  test("#given text naming Native commands #when it is rewritten #then each command token names its V2 command", () => {
    // given
    const text = [
      "Goal paused (/goal resume)",
      "run /memfs init or /init, then `/memory-repository set <url>`",
      "(or /doctor --fix); /memory unlock /tmp/x.lock",
      "/search: query memory",
    ].join("\n")

    // when
    const rewritten = rewriteCommandMentions(text)

    // then
    expect(rewritten).toBe(
      [
        "Goal paused (/omo:goal resume)",
        "run /omo:memfs init or /omo:init, then `/omo:memory-repository set <url>`",
        "(or /omo:doctor --fix); /omo:memory unlock /tmp/x.lock",
        "/omo:search: query memory",
      ].join("\n"),
    )
  })

  test("#given paths, tags, other commands and V2 names #when they are rewritten #then they stay unchanged", () => {
    // given
    const text = [
      "~/.omo/memory/agents and C:/search/x and https://host/init",
      " /memory/notes.md and /init.d and </goal_stall_check>",
      "/review and /goals and /memoryx and /omo:goal and /omo:memory-repository",
    ].join("\n")

    // when
    const once = rewriteCommandMentions(text)

    // then
    expect(once).toBe(text)
    expect(rewriteCommandMentions(rewriteCommandMentions("/goal clear"))).toBe("/omo:goal clear")
  })
})
