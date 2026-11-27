import { describe, expect, test } from "bun:test"
import { ChildProcess, spawnSync } from "node:child_process"

import { endTreeSync, SenpiRunTreeStopError, stopSenpiRunTree } from "./senpi-run-spawn.mjs"

function fakeTaskkill() {
  const fake = new ChildProcess()
  const killed = []
  const calls = []
  fake.kill = (signal) => {
    killed.push(signal)
    return true
  }
  return {
    process: fake,
    killed,
    calls,
    spawnProcess: (executable, args) => {
      calls.push([executable, ...args])
      return fake
    },
  }
}

const settle = (promise) =>
  promise.then(
    (value) => ({ value }),
    (error) => ({ error }),
  )

describe("checked senpi run tree stop on win32", () => {
  test("#given taskkill exits 0 #when the tree is stopped #then it resolves after targeting the run's whole tree", async () => {
    // given
    const taskkill = fakeTaskkill()

    // when
    const stopped = stopSenpiRunTree(4242, { platform: "win32", spawnProcess: taskkill.spawnProcess })
    taskkill.process.emit("exit", 0, null)

    // then
    expect((await settle(stopped)).value).toBe("taskkill /T /F ended pid 4242 and its descendants")
    expect(taskkill.calls).toEqual([["taskkill", "/T", "/F", "/PID", "4242"]])
  })

  test("#given a pid of 0 or none #when the tree is stopped #then it rejects without signalling anything", async () => {
    // given
    const taskkill = fakeTaskkill()

    // when
    const results = await Promise.all(
      [0, -1, undefined].map((pid) =>
        settle(stopSenpiRunTree(pid, { platform: "win32", spawnProcess: taskkill.spawnProcess })),
      ),
    )

    // then
    for (const { error } of results) expect(error).toBeInstanceOf(SenpiRunTreeStopError)
    expect(taskkill.calls).toEqual([])
  })

  test("#given taskkill cannot be spawned #when the tree is stopped #then it rejects naming the pid", async () => {
    // given
    const spawnProcess = () => {
      throw Object.assign(new Error("spawn taskkill ENOENT"), { code: "ENOENT" })
    }

    // when
    const { error } = await settle(stopSenpiRunTree(4242, { platform: "win32", spawnProcess }))

    // then
    expect(error).toBeInstanceOf(SenpiRunTreeStopError)
    expect(error.message).toBe("taskkill could not start for pid 4242")
    expect(error.cause.code).toBe("ENOENT")
  })

  test("#given taskkill reports a spawn error event #when the tree is stopped #then it rejects with that cause", async () => {
    // given
    const taskkill = fakeTaskkill()
    const cause = new Error("EACCES")

    // when
    const stopped = stopSenpiRunTree(4242, { platform: "win32", spawnProcess: taskkill.spawnProcess })
    taskkill.process.emit("error", cause)

    // then
    const { error } = await settle(stopped)
    expect(error).toBeInstanceOf(SenpiRunTreeStopError)
    expect(error.cause).toBe(cause)
  })

  test("#given taskkill exits nonzero #when the tree is stopped #then it rejects naming the exit code", async () => {
    // given
    const taskkill = fakeTaskkill()

    // when
    const stopped = stopSenpiRunTree(4242, { platform: "win32", spawnProcess: taskkill.spawnProcess })
    taskkill.process.emit("exit", 128, null)

    // then
    const { error } = await settle(stopped)
    expect(error).toBeInstanceOf(SenpiRunTreeStopError)
    expect(error.message).toBe("taskkill exited with code 128 for pid 4242")
  })

  test("#given taskkill never finishes #when its deadline passes #then taskkill is killed and the stop rejects", async () => {
    // given
    const taskkill = fakeTaskkill()

    // when
    const { error } = await settle(
      stopSenpiRunTree(4242, { platform: "win32", spawnProcess: taskkill.spawnProcess, deadlineMs: 50 }),
    )

    // then
    expect(error).toBeInstanceOf(SenpiRunTreeStopError)
    expect(error.message).toBe("taskkill did not finish within 50ms for pid 4242")
    expect(taskkill.killed).toEqual(["SIGKILL"])
    taskkill.process.emit("exit", 0, null)
  })
})

describe("bounded synchronous cleanup kill on win32", () => {
  test("#given taskkill exits 0 #when a leftover is ended #then it reports success after targeting the tree", () => {
    // given
    const calls = []
    const spawnSyncImpl = (command, args, options) => {
      calls.push([command, ...args, options.timeout])
      return { status: 0, signal: null }
    }

    // when
    const ended = endTreeSync(4242, { platform: "win32", timeoutMs: 1_000, spawnSyncImpl })

    // then
    expect(ended).toEqual({ ok: true, detail: "taskkill /T /F ended pid 4242 and its descendants" })
    expect(calls).toEqual([["taskkill", "/PID", "4242", "/T", "/F", 1_000]])
  })

  test("#given taskkill exits nonzero or cannot start #when a leftover is ended #then each failure is reported, not thrown", () => {
    // given
    const exitsNonzero = () => ({ status: 128, signal: null })
    const cannotStart = () => ({
      status: null,
      signal: null,
      error: Object.assign(new Error("spawnSync taskkill ENOENT"), { code: "ENOENT" }),
    })

    // when
    const nonzero = endTreeSync(4242, { platform: "win32", spawnSyncImpl: exitsNonzero })
    const missing = endTreeSync(4242, { platform: "win32", spawnSyncImpl: cannotStart })
    const noPid = endTreeSync(0, { platform: "win32", spawnSyncImpl: exitsNonzero })

    // then
    expect(nonzero).toEqual({ ok: false, detail: "taskkill exited with code 128 for pid 4242" })
    expect(missing).toEqual({ ok: false, detail: "taskkill could not start for pid 4242: spawnSync taskkill ENOENT" })
    expect(noPid.ok).toBe(false)
  })

  test("#given a taskkill that hangs #when its timeout passes #then the call returns at the deadline and reports the timeout", () => {
    // given
    const hangingTaskkill = (_command, _args, options) =>
      spawnSync(process.execPath, ["-e", "setInterval(() => {}, 1000)"], options)
    const startedAt = Date.now()

    // when
    const ended = endTreeSync(4242, { platform: "win32", timeoutMs: 300, spawnSyncImpl: hangingTaskkill })

    // then
    expect(ended).toEqual({ ok: false, detail: "taskkill did not finish within 300ms for pid 4242" })
    expect(Date.now() - startedAt).toBeLessThan(10_000)
  })
})
