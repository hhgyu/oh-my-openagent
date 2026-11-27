import { afterEach, describe, expect, test } from "bun:test"
import { spawn, type ChildProcess } from "node:child_process"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { createDefaultProcessKiller, type ProcessKiller } from "./exec"
import { runProcessFamilySweep } from "./family-sweeper"
import { defaultIsProcessAlive, type PsRunner } from "./process-liveness"
import { sweepStaleLspDaemonVersions } from "./sweeper"

// The parent forks a child that exits at once, then blocks in waitid(WEXITED | WNOWAIT): it returns only
// once the child is a zombie and leaves it unreaped. The parent prints the pid after that, and stays until
// its stdin closes, so the zombie exists exactly while the test reads it.
const NON_REAPING_PARENT = `
import os, sys
child = os.fork()
if child == 0:
    os._exit(0)
os.waitid(os.P_PID, child, os.WEXITED | os.WNOWAIT)
sys.stdout.write(f"{child}\\n")
sys.stdout.flush()
sys.stdin.read()
`

const groups: number[] = []
const children: ChildProcess[] = []
const dirs: string[] = []

afterEach(() => {
  for (const group of groups.splice(0)) {
    try {
      process.kill(-group, "SIGKILL")
    } catch {
      // ESRCH: the parent already exited and init reaped the zombie.
      continue
    }
  }
  for (const child of children.splice(0)) child.kill("SIGKILL")
  for (const dir of dirs.splice(0)) rmSync(dir, { force: true, recursive: true })
})

async function startUnreapedZombie(): Promise<{ readonly parent: number; readonly zombie: number }> {
  const parent = spawn("python3", ["-c", NON_REAPING_PARENT], { detached: true, stdio: ["pipe", "pipe", "inherit"] })
  if (parent.pid !== undefined) groups.push(parent.pid)
  const line = await new Promise<string>((resolve, reject) => {
    let buffered = ""
    parent.stdout.on("data", (chunk: Buffer) => {
      buffered += chunk.toString("utf8")
      if (buffered.includes("\n")) resolve(buffered.slice(0, buffered.indexOf("\n")))
    })
    parent.once("error", reject)
    parent.once("exit", (code, signal) => reject(new Error(`zombie parent exited early: ${code ?? signal}`)))
  })
  return { parent: parent.pid ?? 0, zombie: Number(line) }
}

async function startSleeper(): Promise<{ readonly pid: number; readonly exited: Promise<void> }> {
  const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1e9)"], { stdio: "ignore", windowsHide: true })
  children.push(child)
  const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()))
  await new Promise<void>((resolve, reject) => {
    child.once("spawn", () => resolve())
    child.once("error", reject)
  })
  return { pid: child.pid ?? 0, exited }
}

function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  dirs.push(dir)
  return dir
}

// Never settles; records the signal it was handed so the test can see the abort reach the ps child.
function stalledPs(): { readonly runPs: PsRunner; readonly started: Promise<AbortSignal | undefined> } {
  const started = Promise.withResolvers<AbortSignal | undefined>()
  return {
    runPs: (_args, signal) => {
      started.resolve(signal)
      return new Promise(() => {})
    },
    started: started.promise,
  }
}

describe("defaultIsProcessAlive", () => {
  // Windows is not applicable: kill(pid, 0) already fails there once a process stopped running.
  test.skipIf(process.platform === "win32")(
    "#given a POSIX child that exited and whose parent never reaps it #when liveness is checked #then the zombie counts as dead and its parent as alive",
    async () => {
      // given
      const { parent, zombie } = await startUnreapedZombie()

      // when
      const zombieAlive = await defaultIsProcessAlive(zombie)
      const parentAlive = await defaultIsProcessAlive(parent)

      // then
      expect(zombieAlive).toBe(false)
      expect(parentAlive).toBe(true)
    },
  )

  test.each([
    ["exits 2 with no output", { status: 2, stdout: "" }],
    ["cannot run or times out", { status: null, stdout: "" }],
  ] as const)(
    "#given a live process and a ps that %s #when liveness is checked #then the failed observation keeps it alive",
    async (_label, outcome) => {
      // given
      const runPs: PsRunner = () => Promise.resolve(outcome)

      // when
      const alive = await defaultIsProcessAlive(process.pid, { platform: "darwin", runPs })

      // then
      expect(alive).toBe(true)
    },
  )

  test("#given a process that exits while ps reports no such process #when liveness is checked #then the confirmed disappearance counts as dead", async () => {
    // given
    const sleeper = await startSleeper()
    const runPs: PsRunner = async () => {
      process.kill(sleeper.pid, "SIGKILL")
      await sleeper.exited
      return { status: 1, stdout: "" }
    }

    // when
    const alive = await defaultIsProcessAlive(sleeper.pid, { platform: "darwin", runPs })

    // then
    expect(alive).toBe(false)
  })
})

describe("process sweep liveness probe", () => {
  test.skipIf(process.platform === "win32")(
    "#given a sweep over a zombie and two live processes #when it runs with the default killer #then every target is killed and the zombie needs no SIGKILL",
    async () => {
      // given
      const { zombie } = await startUnreapedZombie()
      const sleepers = [await startSleeper(), await startSleeper()]
      const defaultKiller = createDefaultProcessKiller()
      const sigkilled: number[] = []
      const killer: ProcessKiller = {
        ...defaultKiller,
        kill: (pid, signal) => {
          sigkilled.push(pid)
          return defaultKiller.kill(pid, signal)
        },
      }
      const targets = [{ pid: zombie }, ...sleepers.map(({ pid }) => ({ pid }))]

      // when
      const result = await runProcessFamilySweep(
        {
          familyLabel: "liveness multi-candidate",
          stampFile: join(tempDir("liveness-sweep-"), "stamp"),
          collect: () => Promise.resolve({ candidates: targets, killList: targets, spared: [] }),
        },
        { force: true, graceMs: 0, killer },
      )
      await Promise.all(sleepers.map(({ exited }) => exited))

      // then
      expect(result.action).toBe("swept")
      expect(result.failed).toEqual([])
      expect(result.killed.map(({ pid }) => pid)).toEqual(targets.map(({ pid }) => pid))
      expect(sigkilled).not.toContain(zombie)
      expect(await defaultIsProcessAlive(zombie)).toBe(false)
    },
  )

  test("#given a sweep whose post-SIGTERM liveness probe never returns #when the sweep is aborted #then it settles within its stop bound and the abort reaches the probe", async () => {
    // given
    const stalled = stalledPs()
    const controller = new AbortController()
    const sweep = runProcessFamilySweep(
      {
        familyLabel: "liveness stalled probe",
        stampFile: join(tempDir("liveness-stalled-"), "stamp"),
        collect: () =>
          Promise.resolve({ candidates: [{ pid: process.pid }], killList: [{ pid: process.pid }], spared: [] }),
      },
      {
        force: true,
        graceMs: 0,
        signal: controller.signal,
        stopBoundMs: 200,
        killer: {
          isAlive: (pid, signal) =>
            defaultIsProcessAlive(pid, {
              platform: "darwin",
              runPs: stalled.runPs,
              ...(signal === undefined ? {} : { signal }),
            }),
          kill: () => Promise.resolve(),
          terminate: () => Promise.resolve(),
        },
      },
    )
    const probeSignal = await stalled.started

    // when
    const abortedAt = Date.now()
    controller.abort()
    const result = await sweep

    // then
    expect(result.action).toBe("failed")
    expect(Date.now() - abortedAt).toBeLessThan(2_000)
    expect(probeSignal?.aborted).toBe(true)
  })

  test("#given a stale-version sweep whose owner liveness probe never returns #when the sweep is aborted #then it settles within its stop bound and the abort reaches the probe", async () => {
    // given
    const homeDir = tempDir("liveness-stale-version-")
    const versionDir = join(homeDir, ".omo", "lsp-daemon", "v0.0.1")
    mkdirSync(versionDir, { recursive: true })
    writeFileSync(
      join(versionDir, "daemon.owner"),
      `${JSON.stringify({ endpoint: { kind: "unix", path: "/tmp/daemon.sock", dev: 1, ino: 1 }, nonce: "nonce", pid: process.pid, startedAt: "2026-07-21T00:00:00.000Z" })}\n`,
    )
    const stalled = stalledPs()
    const controller = new AbortController()
    const sweep = sweepStaleLspDaemonVersions({
      currentVersion: "9.9.9",
      force: true,
      homeDir,
      platform: "linux",
      signal: controller.signal,
      stopBoundMs: 200,
      isAlive: (pid, signal) =>
        defaultIsProcessAlive(pid, {
          platform: "darwin",
          runPs: stalled.runPs,
          ...(signal === undefined ? {} : { signal }),
        }),
    })
    const probeSignal = await stalled.started

    // when
    const abortedAt = Date.now()
    controller.abort()
    const result = await sweep

    // then
    expect(result.action).toBe("failed")
    expect(Date.now() - abortedAt).toBeLessThan(2_000)
    expect(probeSignal?.aborted).toBe(true)
  })
})
