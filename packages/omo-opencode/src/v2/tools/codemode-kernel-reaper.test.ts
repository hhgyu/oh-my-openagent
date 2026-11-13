import { describe, expect, test } from "bun:test"
import { killKernelTreesSync } from "./codemode-kernel-reaper"

describe("kernel reaper", () => {
  test("#given Windows #when kernels are reaped at exit #then one synchronous tree kill covers every distinct pid", () => {
    // given
    const runs: { command: string; args: readonly string[] }[] = []

    // when
    killKernelTreesSync([11, 22, 11, 0, -3, process.pid], {
      platform: "win32",
      spawnSync: (command, args) => {
        runs.push({ command, args })
      },
    })

    // then
    expect(runs).toEqual([{ command: "taskkill", args: ["/T", "/F", "/PID", "11", "/PID", "22"] }])
  })

  test("#given POSIX #when kernels are reaped #then each process group goes first, then the pid, and failures do not stop the rest", () => {
    // given
    const kills: [number, string][] = []

    // when
    killKernelTreesSync([11, 22], {
      platform: "linux",
      kill: (pid, signal) => {
        kills.push([pid, signal])
        if (pid === -11) throw Error("ESRCH")
      },
    })

    // then
    expect(kills).toEqual([
      [-11, "SIGKILL"],
      [11, "SIGKILL"],
      [-22, "SIGKILL"],
      [22, "SIGKILL"],
    ])
  })

  test("#given nothing live #when reaping #then no process is spawned", () => {
    // given
    let spawned = 0

    // when
    killKernelTreesSync([], {
      platform: "win32",
      spawnSync: () => {
        spawned++
      },
    })

    // then
    expect(spawned).toBe(0)
  })
})
