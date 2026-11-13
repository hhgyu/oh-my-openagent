import { expect, test } from "bun:test"
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createTaskRecordStore } from "./record-store"

test("explicit resident store close drains own cache/fds, retains log, and refuses reuse", () => {
  const dir = mkdtempSync(join(tmpdir(), "senpi-store-close-"))
  const store = createTaskRecordStore({ project_dir: dir, task: { state_dir: dir } })
  try {
    const path = store.appendEvent("st_000000ef", { type: "assistant_message", payload: { text: "retained output" } })
    expect(store.residentFigures().openEventLogs).toBe(1)
    store.close()
    store.close()
    expect(store.residentFigures()).toMatchObject({ openEventLogs: 0, cachedRecords: 0 })
    expect(existsSync(path)).toBe(true)
    expect(readFileSync(path, "utf8")).toContain("retained output")
    expect(() => store.appendEvent("st_000000ef", { type: "late", payload: {} })).toThrow("closed")
    expect(() => store.load("st_000000ef")).toThrow("closed")
  } finally {
    store.close?.()
    rmSync(dir, { recursive: true, force: true })
  }
})
