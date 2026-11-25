import { describe, expect, it } from "bun:test"

import { descendantsOfExitedRoot } from "./windows-owned-tree"

describe("descendants of an exited Windows root", () => {
  it("#given children of the root and of a later process reusing its pid #when selected #then only the root's own subtree is returned", () => {
    // given the root (pid 10) ran from t=1000 to t=5000
    const rows = [
      { pid: 20, ppid: 10, createdAtMs: 2_000 },
      { pid: 30, ppid: 20, createdAtMs: 8_000 },
      { pid: 10, ppid: 4, createdAtMs: 9_000 },
      { pid: 40, ppid: 10, createdAtMs: 9_500 },
      { pid: 50, ppid: 7, createdAtMs: 2_500 },
    ]

    // when
    const selected = descendantsOfExitedRoot(rows, 10, 1_000, 5_000)

    // then
    expect(selected).toEqual([20, 30])
  })
})
