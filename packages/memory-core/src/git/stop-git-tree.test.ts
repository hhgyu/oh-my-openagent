import { afterEach, describe, expect, test } from "bun:test"
import { ChildProcess, spawn } from "node:child_process"
import { once } from "node:events"

import { createWindowsGitTreeStopper, GitTreeStopError, type TaskkillSpawner } from "./stop-git-tree"

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

function fakeTaskkill(): { process: ChildProcess; killed: NodeJS.Signals[]; calls: string[][] } {
  const fake = new ChildProcess()
  const killed: NodeJS.Signals[] = []
  fake.kill = (signal?: NodeJS.Signals | number) => {
    killed.push(typeof signal === "string" ? signal : "SIGTERM")
    return true
  }
  return { process: fake, killed, calls: [] }
}

function spawnerReturning(fake: ReturnType<typeof fakeTaskkill>): TaskkillSpawner {
  return (executable, args) => {
    fake.calls.push([executable, ...args])
    return fake.process
  }
}

describe("Windows git tree stop", () => {
  test("#given taskkill exits 0 #when the tree is stopped #then it resolves after targeting the launcher's tree", async () => {
    // given
    const launcher = startLauncher()
    const taskkill = fakeTaskkill()
    const stop = createWindowsGitTreeStopper({ SystemRoot: "C:\\Windows" }, spawnerReturning(taskkill))

    // when
    const stopped = stop(launcher, 10_000)
    taskkill.process.emit("exit", 0, null)

    // then
    await expect(stopped).resolves.toBeUndefined()
    expect(taskkill.calls).toEqual([["C:\\Windows\\System32\\taskkill.exe", "/PID", String(launcher.pid), "/T", "/F"]])
  })

  test("#given taskkill cannot be spawned #when the tree is stopped #then it rejects and still ends the launcher", async () => {
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

  test("#given taskkill reports a spawn error event #when the tree is stopped #then it rejects with the cause", async () => {
    // given
    const launcher = startLauncher()
    const taskkill = fakeTaskkill()
    const stop = createWindowsGitTreeStopper({}, spawnerReturning(taskkill))

    // when
    const stopped = stop(launcher, 10_000)
    const cause = new Error("EACCES")
    taskkill.process.emit("error", cause)

    // then
    const error = await stopped.then(
      () => undefined,
      (reason: unknown) => reason,
    )
    expect(error).toBeInstanceOf(GitTreeStopError)
    expect((error as GitTreeStopError).cause).toBe(cause)
  })

  test("#given taskkill exits nonzero #when the tree is stopped #then it rejects naming the exit code and ends the launcher", async () => {
    // given
    const launcher = startLauncher()
    const launcherExit = once(launcher, "exit")
    const taskkill = fakeTaskkill()
    const stop = createWindowsGitTreeStopper({}, spawnerReturning(taskkill))

    // when
    const stopped = stop(launcher, 10_000)
    taskkill.process.emit("exit", 128, null)

    // then
    await expect(stopped).rejects.toThrow(`taskkill exited with code 128 for git pid ${launcher.pid}`)
    await launcherExit
  })

  test("#given taskkill never finishes #when its deadline passes #then taskkill is killed, the launcher ended and the stop rejects", async () => {
    // given
    const launcher = startLauncher()
    const launcherExit = once(launcher, "exit")
    const taskkill = fakeTaskkill()
    const stop = createWindowsGitTreeStopper({}, spawnerReturning(taskkill))

    // when
    const error = await stop(launcher, 50).then(
      () => undefined,
      (reason: unknown) => reason,
    )

    // then
    expect(error).toBeInstanceOf(GitTreeStopError)
    expect((error as Error).message).toBe(`taskkill did not finish within 50ms for git pid ${launcher.pid}`)
    expect(taskkill.killed).toEqual(["SIGKILL"])
    await launcherExit
    taskkill.process.emit("exit", 0, null)
  })
})
