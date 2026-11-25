// READY/GO gate of task-id-race-mock-provider.mjs: each parent's first model call publishes READY
// and holds until the driver writes GO, so both parents launch their task in the same instant.
import { existsSync, mkdirSync, writeFileSync } from "node:fs"
import { dirname, isAbsolute } from "node:path"

const FILE_CHECK_INTERVAL_MS = 20

export function waitForGoFile() {
  const readyFile = requiredPath("SENPI_QA_READY_FILE")
  const goFile = requiredPath("SENPI_QA_GO_FILE")
  const timeoutMs = positiveTimeout(process.env.SENPI_QA_GATE_TIMEOUT_MS, 120_000)
  mkdirSync(dirname(readyFile), { recursive: true })
  mkdirSync(dirname(goFile), { recursive: true })
  writeFileSync(readyFile, "ready\n", { flag: "wx" })
  return waitForFile(goFile, timeoutMs, "task-id race gate timed out")
}

// A file written by another process is found by checking for it, not by fs.watch: Bun on macOS
// starts the FSEventStream behind fs.watch asynchronously on its CF thread (since-now, rebuilt for
// every new watcher), so a file created just after the watch call can predate the stream and is
// never reported. Checking on an interval sees every file created before the deadline.
export function waitForFile(path, timeoutMs, timeoutMessage = "timed out") {
  if (existsSync(path)) return Promise.resolve()
  return new Promise((resolve, reject) => {
    const check = setInterval(() => {
      if (!existsSync(path)) return
      clearInterval(check)
      clearTimeout(timer)
      resolve()
    }, FILE_CHECK_INTERVAL_MS)
    const timer = setTimeout(() => {
      clearInterval(check)
      if (existsSync(path)) resolve()
      else reject(new Error(`${timeoutMessage} after ${timeoutMs}ms waiting for ${path}`))
    }, timeoutMs)
  })
}

function requiredPath(name) {
  const value = process.env[name]
  if (typeof value !== "string" || !isAbsolute(value)) throw new Error(`${name} must be an absolute path`)
  return value
}

function positiveTimeout(value, fallback) {
  const parsed = Number(value ?? fallback)
  if (!Number.isFinite(parsed) || parsed <= 0) throw new Error("SENPI_QA_GATE_TIMEOUT_MS must be a positive number")
  return parsed
}
