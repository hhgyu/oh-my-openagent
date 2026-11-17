// READY/GO gate of task-id-race-mock-provider.mjs: each parent's first model call publishes READY
// and holds until the driver writes GO, so both parents launch their task in the same instant.
import { existsSync, mkdirSync, watch, writeFileSync } from "node:fs"
import { basename, dirname, isAbsolute } from "node:path"

// Subscribe before READY is visible, then immediately inspect existence so a GO creation
// between the subscription and this check cannot be missed. There is intentionally no polling.
export function waitForGoFile() {
  const readyFile = requiredPath("SENPI_QA_READY_FILE")
  const goFile = requiredPath("SENPI_QA_GO_FILE")
  const timeoutMs = positiveTimeout(process.env.SENPI_QA_GATE_TIMEOUT_MS, 120_000)
  mkdirSync(dirname(readyFile), { recursive: true })
  mkdirSync(dirname(goFile), { recursive: true })

  return new Promise((resolve, reject) => {
    let settled = false
    let watcher
    const finish = (error) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      watcher?.close()
      if (error === undefined) resolve()
      else reject(error)
    }
    const timer = setTimeout(
      () => finish(new Error(`task-id race gate timed out after ${timeoutMs}ms waiting for ${goFile}`)),
      timeoutMs,
    )
    try {
      watcher = watch(dirname(goFile), (_eventType, filename) => {
        if (filename === null || filename.toString() === basename(goFile)) {
          if (existsSync(goFile)) finish()
        }
      })
      writeFileSync(readyFile, "ready\n", { flag: "wx" })
      if (existsSync(goFile)) finish()
    } catch (error) {
      finish(error instanceof Error ? error : new Error(String(error)))
    }
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
