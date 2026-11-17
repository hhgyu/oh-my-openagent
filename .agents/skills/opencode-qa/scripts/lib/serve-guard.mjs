#!/usr/bin/env bun
// serve-guard.mjs - run a long-lived QA child (e.g. `opencode serve`) so that it
// can never outlive the driver that started it.
//
// Usage:
//   bun serve-guard.mjs --parent-pid <pid> [--pid-file <path>] -- <command> [args...]
//
// --pid-file receives the child pid once it is spawned; on POSIX that is also the
// child's process-group id, so a driver trap can `kill -- -<pgid>` even if the
// guard itself was SIGKILLed (the one case a POSIX guard cannot intercept).
//
// Guarantees, on normal exit, error, signal, forced kill of the guard, and
// death of the parent driver:
//   - Windows: the guard joins a Job Object with JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE
//     BEFORE spawning, so the child and every descendant (the ~/.bun/bin shim and
//     the real opencode binary it launches) live in that job. The only job handle
//     is held by the guard, so the kernel kills the whole tree the moment the guard
//     exits for any reason, including `taskkill /F` of the guard alone. The guard
//     refuses to run the child unguarded if the job cannot be set up or the child
//     is not inside it.
//   - POSIX: the child leads its own process group; the guard kills the group on
//     exit, on SIGINT/SIGTERM/SIGHUP, and when the parent disappears.
//   - Both: the guard watches --parent-pid (Windows: through an open process
//     handle, which also blocks PID reuse) and tears the tree down when the
//     driver dies without running its cleanup trap (SIGKILL, taskkill /F).
//
// Exit codes: the child's exit code; 3 = guard setup failed (child not started
// or killed immediately); 4 = parent driver vanished; 128+N on signal N.

import { spawn } from "node:child_process"
import { writeFileSync } from "node:fs"
import { constants } from "node:os"

const POLL_MS = 250
const POSIX_GRACE_MS = 3000
const isWindows = process.platform === "win32"

function fail(message) {
  process.stderr.write(`[serve-guard] ${message}\n`)
}

function parseArgs(argv) {
  const separator = argv.indexOf("--")
  if (separator < 0 || separator === argv.length - 1) return null
  const options = argv.slice(0, separator)
  const command = argv.slice(separator + 1)
  let parentPid = 0
  let pidFile = ""
  for (let index = 0; index < options.length; index += 1) {
    if (options[index] === "--parent-pid") {
      parentPid = Number.parseInt(options[index + 1] ?? "", 10)
      index += 1
    } else if (options[index] === "--pid-file") {
      pidFile = options[index + 1] ?? ""
      index += 1
    } else {
      return null
    }
  }
  if (!Number.isInteger(parentPid) || parentPid <= 0) return null
  return { parentPid, pidFile, command }
}

async function createWindowsJobGuard() {
  const { dlopen, FFIType, ptr } = await import("bun:ffi")
  const kernel32 = dlopen("kernel32.dll", {
    CreateJobObjectW: { args: [FFIType.ptr, FFIType.ptr], returns: FFIType.ptr },
    SetInformationJobObject: { args: [FFIType.ptr, FFIType.i32, FFIType.ptr, FFIType.u32], returns: FFIType.i32 },
    AssignProcessToJobObject: { args: [FFIType.ptr, FFIType.ptr], returns: FFIType.i32 },
    IsProcessInJob: { args: [FFIType.ptr, FFIType.ptr, FFIType.ptr], returns: FFIType.i32 },
    OpenProcess: { args: [FFIType.u32, FFIType.i32, FFIType.u32], returns: FFIType.ptr },
    GetExitCodeProcess: { args: [FFIType.ptr, FFIType.ptr], returns: FFIType.i32 },
    CloseHandle: { args: [FFIType.ptr], returns: FFIType.i32 },
    GetLastError: { args: [], returns: FFIType.u32 },
  }).symbols

  const PROCESS_TERMINATE = 0x0001
  const PROCESS_SET_QUOTA = 0x0100
  const PROCESS_QUERY_LIMITED_INFORMATION = 0x1000
  const SYNCHRONIZE = 0x00100000
  const STILL_ACTIVE = 259
  const JOB_OBJECT_EXTENDED_LIMIT_INFORMATION_CLASS = 9
  const JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE = 0x2000
  // sizeof(JOBOBJECT_EXTENDED_LIMIT_INFORMATION) on 64-bit Windows; LimitFlags at offset 16.
  const EXTENDED_LIMIT_SIZE = 144

  const job = kernel32.CreateJobObjectW(null, null)
  if (!job) throw new Error(`CreateJobObjectW failed (${kernel32.GetLastError()})`)
  const limits = new Uint8Array(EXTENDED_LIMIT_SIZE)
  new DataView(limits.buffer).setUint32(16, JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE, true)
  if (
    !kernel32.SetInformationJobObject(
      job,
      JOB_OBJECT_EXTENDED_LIMIT_INFORMATION_CLASS,
      ptr(limits),
      EXTENDED_LIMIT_SIZE,
    )
  ) {
    throw new Error(`SetInformationJobObject failed (${kernel32.GetLastError()})`)
  }
  const self = kernel32.OpenProcess(PROCESS_SET_QUOTA | PROCESS_TERMINATE, 0, process.pid)
  if (!self) throw new Error(`OpenProcess(self) failed (${kernel32.GetLastError()})`)
  if (!kernel32.AssignProcessToJobObject(job, self)) {
    throw new Error(`AssignProcessToJobObject(self) failed (${kernel32.GetLastError()})`)
  }
  kernel32.CloseHandle(self)

  const isInJob = (pid) => {
    const handle = kernel32.OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid)
    if (!handle) return false
    const result = new Int32Array(1)
    const ok = kernel32.IsProcessInJob(handle, job, ptr(result))
    kernel32.CloseHandle(handle)
    return ok !== 0 && result[0] !== 0
  }

  const watchParent = (parentPid) => {
    const handle = kernel32.OpenProcess(SYNCHRONIZE | PROCESS_QUERY_LIMITED_INFORMATION, 0, parentPid)
    if (!handle) return () => false
    const code = new Uint32Array(1)
    return () => kernel32.GetExitCodeProcess(handle, ptr(code)) !== 0 && code[0] === STILL_ACTIVE
  }

  return { isInJob, watchParent }
}

function watchPosixParent(parentPid) {
  const initialPpid = process.ppid
  return () => {
    if (initialPpid === parentPid && process.ppid !== initialPpid) return false
    try {
      process.kill(parentPid, 0)
      return true
    } catch (error) {
      return error?.code === "EPERM"
    }
  }
}

function killPosixGroup(child, signal) {
  if (!child?.pid) return
  try {
    process.kill(-child.pid, signal)
  } catch (error) {
    if (error?.code !== "ESRCH") fail(`kill(-${child.pid}, ${signal}) failed: ${error?.message ?? error}`)
  }
}

async function main() {
  const parsed = parseArgs(process.argv.slice(2))
  if (!parsed) {
    fail("usage: bun serve-guard.mjs --parent-pid <pid> [--pid-file <path>] -- <command> [args...]")
    process.exit(2)
  }
  const { parentPid, pidFile, command } = parsed

  let windowsGuard = null
  let parentAlive
  if (isWindows) {
    try {
      windowsGuard = await createWindowsJobGuard()
    } catch (error) {
      fail(`refusing to start unguarded child: ${error?.message ?? error}`)
      process.exit(3)
    }
    parentAlive = windowsGuard.watchParent(parentPid)
  } else {
    parentAlive = watchPosixParent(parentPid)
  }
  if (!parentAlive()) {
    fail(`parent ${parentPid} is not running; not starting the child`)
    process.exit(4)
  }

  const child = spawn(command[0], command.slice(1), {
    stdio: ["ignore", "inherit", "inherit"],
    windowsHide: true,
    detached: !isWindows,
  })

  let exiting = false
  const teardown = (code) => {
    if (exiting) return
    exiting = true
    if (isWindows) {
      // Closing the last job handle (process exit) kills every process in the job.
      process.exit(code)
    }
    killPosixGroup(child, "SIGTERM")
    const deadline = setTimeout(() => {
      killPosixGroup(child, "SIGKILL")
      process.exit(code)
    }, POSIX_GRACE_MS)
    child.once("exit", () => {
      clearTimeout(deadline)
      killPosixGroup(child, "SIGKILL")
      process.exit(code)
    })
    if (child.exitCode !== null || child.signalCode !== null) child.emit("exit")
  }

  child.once("error", (error) => {
    fail(`failed to start ${command[0]}: ${error?.message ?? error}`)
    teardown(3)
  })
  child.once("spawn", () => {
    if (pidFile) {
      try {
        writeFileSync(pidFile, `${child.pid}\n`)
      } catch (error) {
        fail(`cannot write --pid-file ${pidFile}: ${error?.message ?? error}`)
        teardown(3)
        return
      }
    }
    if (windowsGuard && !windowsGuard.isInJob(child.pid)) {
      fail(`child ${child.pid} escaped the kill-on-close job; killing it`)
      try {
        process.kill(child.pid, "SIGKILL")
      } catch (error) {
        fail(`kill(${child.pid}) failed: ${error?.message ?? error}`)
      }
      teardown(3)
    }
  })
  child.once("exit", (code, signal) => {
    if (exiting) return
    const signalNumber = signal ? 128 + (constants.signals[signal] ?? 0) : null
    teardown(code ?? signalNumber ?? 1)
  })

  for (const [signal, number] of [
    ["SIGINT", 2],
    ["SIGTERM", 15],
    ["SIGHUP", 1],
  ]) {
    process.on(signal, () => teardown(128 + number))
  }
  process.on("exit", () => {
    if (!isWindows && !exiting) killPosixGroup(child, "SIGKILL")
  })

  setInterval(() => {
    if (!parentAlive()) {
      fail(`parent ${parentPid} vanished; tearing down the child tree`)
      teardown(4)
    }
  }, POLL_MS)
}

await main()
