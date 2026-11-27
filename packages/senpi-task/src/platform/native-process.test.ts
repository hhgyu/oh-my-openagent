import { afterEach, describe, expect, test } from "bun:test"
import { type ChildProcessByStdio, spawn } from "node:child_process"
import { once } from "node:events"
import type { Readable } from "node:stream"
import { readProcessCpuSeconds } from "./native-process"
import { readProcessTreeCpuSeconds } from "./process-tree-cpu"

// The startup bounds (stall window, CPU cap) read a child's CPU seconds through this reader. A wrong unit silently moves
// every bound: on Apple Silicon proc_taskinfo counts Mach ticks of 125/3 ns, so reading them as nanoseconds made the
// 120 s cap ~83 min of real CPU (#14808 review M1). The reader must agree with the runtime's own CPU clock.
describe("readProcessCpuSeconds", () => {
  test("#given this process burned at least half a CPU second #when its CPU is read #then it matches the runtime's own CPU clock", () => {
    // given: spin until the runtime itself has counted 0.5 s of CPU, so the amount does not depend on host load
    const startMicros = process.cpuUsage()
    const elapsedCpuSeconds = () => {
      const usage = process.cpuUsage(startMicros)
      return (usage.user + usage.system) / 1e6
    }
    const before = readProcessCpuSeconds(process.pid)
    while (elapsedCpuSeconds() < 0.5) {}
    const runtimeSeconds = elapsedCpuSeconds()

    // when
    const after = readProcessCpuSeconds(process.pid)

    // then
    expect(before).not.toBeNull()
    expect(after).not.toBeNull()
    const readerSeconds = (after ?? 0) - (before ?? 0)
    expect(readerSeconds).toBeGreaterThan(runtimeSeconds * 0.8)
    expect(readerSeconds).toBeLessThan(runtimeSeconds * 1.25)
  })

  test("#given a pid that is not a positive integer #then nothing is read", () => {
    expect(readProcessCpuSeconds(0)).toBeNull()
    expect(readProcessCpuSeconds(-1)).toBeNull()
    expect(readProcessCpuSeconds(1.5)).toBeNull()
  })
})

// A launcher that starts the engine as its own child (an npm shim, a wrapper script) idles while the engine boots. The
// startup bounds read the whole tree, so the engine's CPU must show up under the launcher's pid (#14820).
const GRANDCHILD =
  'console.log("started " + process.pid); const s = process.cpuUsage(); const burned = () => { const u = process.cpuUsage(s); return (u.user + u.system) / 1e6 }; while (burned() < 0.6) {} console.log("burned"); setInterval(() => {}, 1000)'
// The wrapper follows its child out, so a grandchild that dies before it reports ends the wait instead of leaving the
// wrapper idling on an open pipe.
const WRAPPER = `require("node:child_process").spawn(process.execPath, ["-e", ${JSON.stringify(GRANDCHILD)}], { stdio: "inherit" }).on("exit", (code) => process.exit(code ?? 1)); setInterval(() => {}, 1000)`

interface LauncherTree {
  readonly wrapper: ChildProcessByStdio<null, Readable, null>
  readonly pipeClosed: Promise<unknown>
  readonly exited: Promise<unknown>
  output: string
  grandchildPid?: number
}

let launched: LauncherTree | undefined

function launchTree(): LauncherTree {
  const wrapper = spawn(process.execPath, ["-e", WRAPPER], {
    detached: process.platform !== "win32",
    stdio: ["ignore", "pipe", "inherit"],
  })
  const tree: LauncherTree = {
    wrapper,
    pipeClosed: once(wrapper.stdout, "close"),
    exited: once(wrapper, "exit"),
    output: "",
  }
  // A spawn error rejects `exited`; afterEach still awaits it, so the failure surfaces there.
  tree.exited.catch(() => undefined)
  wrapper.stdout.on("data", (chunk: Buffer) => {
    tree.output += chunk.toString()
    const started = /started (\d+)/.exec(tree.output)
    if (started !== null) tree.grandchildPid = Number(started[1])
  })
  launched = tree
  return tree
}

// Resolves once the grandchild reports its burned CPU, and rejects as soon as the tree can no longer report: the
// wrapper failed to spawn, exited, or every holder of its stdout closed it.
function grandchildBurned(tree: LauncherTree): Promise<void> {
  return new Promise((resolve, reject) => {
    const stdout = tree.wrapper.stdout
    const settle = () => {
      stdout.off("data", onData)
      stdout.off("end", onEnd)
      tree.wrapper.off("exit", onExit)
      tree.wrapper.off("error", onError)
    }
    const onData = () => {
      if (!tree.output.includes("burned")) return
      settle()
      resolve()
    }
    const onEnd = () => {
      settle()
      reject(
        new Error(
          `the launcher tree closed its stdout before the grandchild reported (output: ${JSON.stringify(tree.output)})`,
        ),
      )
    }
    const onExit = (code: number | null, signal: string | null) => {
      settle()
      reject(new Error(`the launcher exited (code ${code}, signal ${signal}) before the grandchild reported`))
    }
    const onError = (error: Error) => {
      settle()
      reject(error)
    }
    stdout.on("data", onData)
    stdout.on("end", onEnd)
    tree.wrapper.on("exit", onExit)
    tree.wrapper.on("error", onError)
    onData()
  })
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ESRCH") return false
    throw error
  }
}

async function killTree(pid: number): Promise<void> {
  if (process.platform !== "win32") {
    try {
      process.kill(-pid, "SIGKILL")
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error
    }
    return
  }
  if (!isAlive(pid)) return
  const taskkill = spawn("taskkill", ["/pid", String(pid), "/t", "/f"], { stdio: "ignore" })
  const [code] = (await once(taskkill, "exit")) as [number | null]
  // 128: the process exited between the liveness check and taskkill, which is the state this cleanup wants.
  if (code !== 0 && code !== 128) throw new Error(`taskkill /t /f for pid ${pid} exited ${code}`)
}

// afterEach also runs after a test that timed out, so the tree is ended even when the test body never reached cleanup.
afterEach(async () => {
  const tree = launched
  launched = undefined
  if (tree === undefined) return
  if (tree.wrapper.pid !== undefined) await killTree(tree.wrapper.pid)
  // A wrapper that died on its own leaves its tree unreachable through its pid on Windows; end the grandchild by its own.
  if (process.platform === "win32" && tree.grandchildPid !== undefined) await killTree(tree.grandchildPid)
  await tree.exited
  // The grandchild inherited the pipe, so the pipe closes only once no process of the tree holds it.
  await tree.pipeClosed
  if (tree.grandchildPid !== undefined && process.platform === "win32") expect(isAlive(tree.grandchildPid)).toBe(false)
})

describe("readProcessTreeCpuSeconds", () => {
  test("#given a launcher that idles while its child burns CPU #when the launcher's tree is read #then the child's CPU counts", async () => {
    // given: wait for the grandchild to report its own 0.6 CPU s, so no wall clock decides the amount
    const tree = launchTree()
    await grandchildBurned(tree)
    const pid = tree.wrapper.pid ?? 0

    // when
    const launcherOnly = readProcessCpuSeconds(pid)
    const treeSeconds = readProcessTreeCpuSeconds(pid)

    // then
    expect(launcherOnly).not.toBeNull()
    expect(launcherOnly ?? 0).toBeLessThan(0.45)
    expect(treeSeconds ?? 0).toBeGreaterThan((launcherOnly ?? 0) + 0.45)
  })
})
