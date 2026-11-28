import { afterEach, describe, expect, test } from "bun:test"
import { ChildProcess, spawn } from "node:child_process"
import { once } from "node:events"

import {
  createWindowsGitTreeStopper,
  GitTreeStopError,
  type TaskkillResult,
  type TaskkillRunner,
} from "./stop-git-tree"

const launchers: ChildProcess[] = []

afterEach(async () => {
  for (const launcher of launchers.splice(0)) {
    if (launcher.exitCode !== null || launcher.signalCode !== null) continue
    const exited = once(launcher, "exit")
    launcher.kill("SIGKILL")
    await exited
  }
})

function startLauncher(): ChildProcess {
  const launcher = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" })
  launchers.push(launcher)
  return launcher
}

// Runs until its stdin closes, standing in for a git that finishes on its own.
function startSelfEndingLauncher(): ChildProcess {
  const launcher = spawn(
    process.execPath,
    ["-e", "process.stdin.resume(); process.stdin.on('end', () => process.exit(0))"],
    {
      stdio: ["pipe", "ignore", "ignore"],
    },
  )
  launchers.push(launcher)
  return launcher
}

// A taskkill outcome that is also a ChildProcess emitting the same outcome, so the stopper sees one result
// whether it reads the finished run or waits on the process.
function taskkillOutcome(result: TaskkillResult): ChildProcess & TaskkillResult {
  const fake = Object.assign(new ChildProcess(), result)
  fake.kill = () => true
  setImmediate(() => {
    if (result.error !== undefined) {
      if (fake.listenerCount("error") > 0) fake.emit("error", result.error)
    } else fake.emit("exit", result.status, result.signal)
  })
  return fake
}

function recordingRunner(
  result: TaskkillResult,
  duringRun: () => void = () => {},
): { runner: TaskkillRunner; calls: unknown[][] } {
  const calls: unknown[][] = []
  return {
    calls,
    runner: (executable, args, timeoutMs) => {
      calls.push([executable, ...args, timeoutMs])
      duringRun()
      return taskkillOutcome(result)
    },
  }
}

const settle = (promise: Promise<void>) =>
  promise.then(
    () => undefined,
    (reason: unknown) => reason,
  )

describe("Windows git tree stop", () => {
  test("#given taskkill exits 0 #when the tree is stopped #then it resolves after targeting the launcher's tree within the deadline", async () => {
    // given
    const launcher = startLauncher()
    const taskkill = recordingRunner({ status: 0, signal: null })
    const stop = createWindowsGitTreeStopper({ SystemRoot: "C:\\Windows" }, taskkill.runner)

    // when
    const stopped = stop(launcher, 10_000)

    // then
    await expect(stopped).resolves.toBeUndefined()
    expect(taskkill.calls).toEqual([
      ["C:\\Windows\\System32\\taskkill.exe", "/PID", String(launcher.pid), "/T", "/F", 10_000],
    ])
  })

  test("#given taskkill cannot be run #when the tree is stopped #then it rejects and still ends the launcher", async () => {
    // given
    const launcher = startLauncher()
    const launcherExit = once(launcher, "exit")
    const stop = createWindowsGitTreeStopper({}, () => {
      throw Object.assign(new Error("spawn taskkill.exe ENOENT"), { code: "ENOENT" })
    })

    // when
    const stopped = stop(launcher, 10_000)

    // then
    await expect(stopped).rejects.toThrow(/taskkill could not start/)
    await expect(stopped).rejects.toBeInstanceOf(GitTreeStopError)
    await launcherExit
  })

  test("#given taskkill reports a spawn error #when the tree is stopped #then it rejects with the cause", async () => {
    // given
    const launcher = startLauncher()
    const cause = Object.assign(new Error("spawnSync taskkill.exe EACCES"), { code: "EACCES" })
    const stop = createWindowsGitTreeStopper({}, recordingRunner({ status: null, signal: null, error: cause }).runner)

    // when
    const error = await settle(stop(launcher, 10_000))

    // then
    expect(error).toBeInstanceOf(GitTreeStopError)
    expect((error as GitTreeStopError).message).toBe(`taskkill could not start for git pid ${launcher.pid}`)
    expect((error as GitTreeStopError).cause).toBe(cause)
  })

  test("#given taskkill exits nonzero #when the tree is stopped #then it rejects naming the exit code and ends the launcher", async () => {
    // given
    const launcher = startLauncher()
    const launcherExit = once(launcher, "exit")
    const stop = createWindowsGitTreeStopper({}, recordingRunner({ status: 1, signal: null }).runner)

    // when
    const stopped = stop(launcher, 10_000)

    // then
    await expect(stopped).rejects.toThrow(`taskkill exited with code 1 for git pid ${launcher.pid}`)
    await launcherExit
  })

  test("#given taskkill outlives its deadline #when the tree is stopped #then the launcher is ended and the stop rejects", async () => {
    // given
    const launcher = startLauncher()
    const launcherExit = once(launcher, "exit")
    const timeout = Object.assign(new Error("spawnSync taskkill.exe ETIMEDOUT"), { code: "ETIMEDOUT" })
    const taskkill = recordingRunner({ status: null, signal: "SIGKILL", error: timeout })
    const stop = createWindowsGitTreeStopper({}, taskkill.runner)

    // when
    const error = await settle(stop(launcher, 50))

    // then
    expect(error).toBeInstanceOf(GitTreeStopError)
    expect((error as Error).message).toBe(`taskkill did not finish within 50ms for git pid ${launcher.pid}`)
    expect(taskkill.calls[0]?.at(-1)).toBe(50)
    await launcherExit
  })

  test("#given the launcher already exited #when the tree is stopped #then no taskkill targets its freed pid", async () => {
    // given
    const launcher = startLauncher()
    const launcherExit = once(launcher, "exit")
    launcher.kill("SIGKILL")
    await launcherExit
    const taskkill = recordingRunner({ status: 0, signal: null })
    const stop = createWindowsGitTreeStopper({}, taskkill.runner)

    // when
    const stopped = stop(launcher, 10_000)

    // then
    await expect(stopped).resolves.toBeUndefined()
    expect(taskkill.calls).toEqual([])
  })

  test("#given the launcher ends on its own while taskkill looks for it #when taskkill finds no such process #then the stop settles once the launcher's exit arrives", async () => {
    // given
    const launcher = startSelfEndingLauncher()
    let unreapedWhileTaskkillRan: boolean | undefined
    const taskkill = recordingRunner({ status: 128, signal: null }, () => {
      launcher.stdin?.end()
      unreapedWhileTaskkillRan = launcher.exitCode === null && launcher.signalCode === null
    })
    const stop = createWindowsGitTreeStopper({}, taskkill.runner)

    // when
    const stopped = stop(launcher, 10_000)

    // then
    await expect(stopped).resolves.toBeUndefined()
    expect(unreapedWhileTaskkillRan).toBe(true)
    expect(launcher.exitCode).toBe(0)
  })

  test("#given the launcher has exited but its exit is not yet reported #when the tree is stopped #then no taskkill runs and the stop settles once the exit arrives", async () => {
    // given
    const launcher = startSelfEndingLauncher()
    const taskkill = recordingRunner({ status: 0, signal: null })
    const probed: number[] = []
    const stop = createWindowsGitTreeStopper({}, taskkill.runner, (pid) => {
      probed.push(pid)
      launcher.stdin?.end()
      return false
    })

    // when
    const stopped = stop(launcher, 10_000)

    // then
    await expect(stopped).resolves.toBeUndefined()
    expect(probed).toEqual([launcher.pid ?? -1])
    expect(taskkill.calls).toEqual([])
    expect(launcher.exitCode).toBe(0)
  })

  test("#given taskkill finds no such process but the launcher keeps running #when the deadline passes #then the stop rejects and ends the launcher", async () => {
    // given
    const launcher = startLauncher()
    const launcherExit = once(launcher, "exit")
    const stop = createWindowsGitTreeStopper({}, recordingRunner({ status: 128, signal: null }).runner)

    // when
    const error = await settle(stop(launcher, 50))

    // then
    expect(error).toBeInstanceOf(GitTreeStopError)
    expect((error as Error).message).toBe(`taskkill exited with code 128 for git pid ${launcher.pid}`)
    await launcherExit
  })

  test("#given taskkill used the whole budget and found no such process #when the launcher keeps running #then the stop rejects at once instead of waiting a second budget", async () => {
    // given
    const launcher = startLauncher()
    const launcherExit = once(launcher, "exit")
    let clock = 0
    const stop = createWindowsGitTreeStopper(
      {},
      recordingRunner({ status: 128, signal: null }, () => {
        clock += 60_000
      }).runner,
      () => true,
      () => clock,
    )

    // when
    const error = await settle(stop(launcher, 60_000))

    // then
    expect(error).toBeInstanceOf(GitTreeStopError)
    expect((error as Error).message).toBe(`taskkill exited with code 128 for git pid ${launcher.pid}`)
    await launcherExit
  })

  test("#given a launcher without a positive pid #when the tree is stopped #then it rejects without running taskkill", async () => {
    // given
    const launcher = Object.defineProperty(new ChildProcess(), "pid", { value: 0 })
    const taskkill = recordingRunner({ status: 0, signal: null })
    const stop = createWindowsGitTreeStopper({}, taskkill.runner)

    // when
    const error = await settle(stop(launcher, 10_000))

    // then
    expect(error).toBeInstanceOf(GitTreeStopError)
    expect(taskkill.calls).toEqual([])
  })
})
