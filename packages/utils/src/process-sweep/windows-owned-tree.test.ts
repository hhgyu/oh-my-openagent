import { describe, expect, it } from "bun:test"

import { ownedDescendants } from "./windows-owned-tree"

// The owned root is pid 10, alive from t=1000 to t=5000 (ticks).
const ROOT = { pid: 10, creationTicks: 1_000n, exitTicks: 5_000n }

describe("descendants of an owned Windows root", () => {
  it("#given the root exited and a descendant created while it ran still holds its pipes #when selected #then that descendant and its own subtree are returned", () => {
    // given
    const rows = [
      { pid: 20, ppid: 10, creationTicks: 2_000n },
      { pid: 30, ppid: 20, creationTicks: 8_000n },
      { pid: 50, ppid: 7, creationTicks: 2_500n },
    ]

    // when
    const selected = ownedDescendants(rows, ROOT).map((row) => row.pid)

    // then
    expect(selected).toEqual([20, 30])
  })

  it("#given a replacement reused the root's pid inside the slack window #when selected #then no process is returned", () => {
    // given
    const rows = [
      { pid: 10, ppid: 4, creationTicks: 5_100n },
      { pid: 40, ppid: 10, creationTicks: 5_500n },
      { pid: 41, ppid: 10, creationTicks: 5_600n },
    ]

    // when
    const selected = ownedDescendants(rows, ROOT)

    // then
    expect(selected).toEqual([])
  })

  it("#given a replacement reused the root's pid long after it exited #when selected #then no process is returned", () => {
    // given
    const rows = [
      { pid: 20, ppid: 10, creationTicks: 2_000n },
      { pid: 10, ppid: 4, creationTicks: 90_000n },
      { pid: 40, ppid: 10, creationTicks: 95_000n },
    ]

    // when
    const selected = ownedDescendants(rows, ROOT)

    // then
    expect(selected).toEqual([])
  })

  it("#given children naming the exited root's pid that were created after it exited #when selected #then they are not returned", () => {
    // given
    const rows = [
      { pid: 20, ppid: 10, creationTicks: 2_000n },
      { pid: 40, ppid: 10, creationTicks: 5_600n },
    ]

    // when
    const selected = ownedDescendants(rows, ROOT).map((row) => row.pid)

    // then
    expect(selected).toEqual([20])
  })

  it("#given an exited root whose exit time is unknown #when selected #then no process is returned", () => {
    // given
    const rows = [{ pid: 20, ppid: 10, creationTicks: 2_000n }]

    // when
    const selected = ownedDescendants(rows, { pid: 10, creationTicks: 1_000n, exitTicks: null })

    // then
    expect(selected).toEqual([])
  })

  it("#given a grandchild whose parent pid was taken by a process created after it #when selected #then the link is not followed", () => {
    // given pid 30 now belongs to a process created after the row naming it as parent
    const rows = [
      { pid: 20, ppid: 10, creationTicks: 2_000n },
      { pid: 30, ppid: 20, creationTicks: 9_000n },
      { pid: 60, ppid: 30, creationTicks: 8_500n },
    ]

    // when
    const selected = ownedDescendants(rows, ROOT).map((row) => row.pid)

    // then
    expect(selected).toEqual([20, 30])
  })
})
