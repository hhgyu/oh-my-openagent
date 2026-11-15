import { existsSync, readdirSync } from "node:fs"
import { homedir } from "node:os"
import { join, resolve } from "node:path"
import type { Registration } from "@opencode/plugin/promise/registration"
import type { RpcHandlers, RpcRegistration } from "@opencode/plugin/promise/rpc"
import { createTaskRecordStore, type TaskRecord } from "@oh-my-opencode/senpi-task/manager-kernel"
import { projectTaskWidgetEntry, taskRecordInSession } from "@oh-my-opencode/senpi-task/task-widget"
import { taskStatusRpc, type TaskStatusSnapshot } from "../../rpc/task"
import { nativeTaskStateDir } from "./state-dir"

export interface TaskStatusRpcPort {
  register(
    definition: typeof taskStatusRpc,
    handlers: RpcHandlers<typeof taskStatusRpc>,
  ): Promise<RpcRegistration<typeof taskStatusRpc>>
}

const MAX_LISTED_TASKS = 50
const DEFAULT_DEBOUNCE_MS = 250
const STATE_DIR_NAME = /^[0-9a-f]{64}$/

type RecordStore = ReturnType<typeof createTaskRecordStore>

/**
 * The OmO task panel's server half: a read-only projection of the persisted task records of a session
 * (the tasks it spawned plus, for a root, its whole tree), read from the very journal the Native task
 * runtime writes, so a task stays `running` exactly as long as its record does and a restarted server
 * lists revived tasks again. Store mutations of a live runtime push a debounced, deduplicated update.
 */
export function createTaskStatusRpc(deps: { readonly directory: string; readonly debounceMs?: number }) {
  const debounceMs = deps.debounceMs ?? DEFAULT_DEBOUNCE_MS
  const stores = new Map<string, RecordStore>()
  const sessionDirs = new Map<string, string>()
  const published = new Map<string, string>()
  const chains = new Map<string, Promise<void>>()
  const pending = new Set<string>()
  let timer: ReturnType<typeof setTimeout> | undefined
  let events: RpcRegistration<typeof taskStatusRpc>["events"] | undefined
  let closed = false

  function storeAt(stateDir: string): RecordStore {
    let store = stores.get(stateDir)
    if (!store) {
      store = createTaskRecordStore({ project_dir: deps.directory, task: { state_dir: stateDir } })
      stores.set(stateDir, store)
    }
    return store
  }
  function readRecords(stateDir: string): readonly TaskRecord[] {
    if (!existsSync(join(stateDir, "tasks"))) return []
    const records = storeAt(stateDir).list().records
    for (const record of records) learn(stateDir, record)
    return records
  }
  // A record maps its sessions to a state directory only when that directory is its root's own, so a
  // record cannot point a session at storage that belongs to another tree.
  function learn(stateDir: string, record: TaskRecord): void {
    if (nativeTaskStateDir(deps.directory, record.root_session_id) !== stateDir) return
    sessionDirs.set(record.root_session_id, stateDir)
    sessionDirs.set(record.parent_session_id, stateDir)
  }
  // Never walks the project's `.omo` when the project directory is $HOME (there it is the OmO home).
  function discover(sessionID: string): string | undefined {
    if (resolve(deps.directory) === resolve(homedir())) return undefined
    const base = join(deps.directory, ".omo", "tasks", "opencode-v2")
    if (!existsSync(base)) return undefined
    for (const entry of readdirSync(base, { withFileTypes: true })) {
      if (!entry.isDirectory() || !STATE_DIR_NAME.test(entry.name)) continue
      readRecords(join(base, entry.name))
      const found = sessionDirs.get(sessionID)
      if (found !== undefined) return found
    }
    return undefined
  }
  function snapshot(sessionID: string): TaskStatusSnapshot {
    const own = nativeTaskStateDir(deps.directory, sessionID)
    let records = readRecords(sessionDirs.get(sessionID) ?? own).filter((record) =>
      taskRecordInSession(record, sessionID),
    )
    if (records.length === 0 && !sessionDirs.has(sessionID)) {
      const found = discover(sessionID)
      if (found !== undefined) records = readRecords(found).filter((record) => taskRecordInSession(record, sessionID))
    }
    const listed = [...records]
      .sort((a, b) => a.created_at.localeCompare(b.created_at) || a.task_id.localeCompare(b.task_id))
      .slice(-MAX_LISTED_TASKS)
    return { sessionID, tasks: listed.map(projectTaskWidgetEntry) }
  }
  function publish(sessionID: string): void {
    if (closed || events === undefined) return
    const emitter = events
    const next = (chains.get(sessionID) ?? Promise.resolve())
      .then(async () => {
        if (closed) return
        const current = snapshot(sessionID)
        const fingerprint = JSON.stringify(current)
        if (published.get(sessionID) === fingerprint) return
        await emitter.emit("updated", current)
        published.set(sessionID, fingerprint)
      })
      .catch((error: unknown) => {
        console.warn(
          "[oh-my-openagent/v2] task panel update skipped",
          sessionID,
          error instanceof Error ? error.message : String(error),
        )
      })
    chains.set(sessionID, next)
    void next.finally(() => {
      if (chains.get(sessionID) === next) chains.delete(sessionID)
    })
  }
  function flush(): void {
    if (timer !== undefined) clearTimeout(timer)
    timer = undefined
    const sessions = [...pending]
    pending.clear()
    for (const sessionID of sessions) publish(sessionID)
  }
  function schedule(sessionIDs: Iterable<string>): void {
    if (closed) return
    for (const sessionID of sessionIDs) pending.add(sessionID)
    if (timer !== undefined || pending.size === 0) return
    timer = setTimeout(flush, debounceMs)
    timer.unref?.()
  }
  return {
    async register(rpc: TaskStatusRpcPort): Promise<Registration> {
      const registration = await rpc.register(taskStatusRpc, {
        status: async ({ sessionID }) => {
          if (closed) throw Error("Task panel status is closed")
          return snapshot(sessionID)
        },
      })
      events = registration.events
      return registration
    },
    /** A store write of the runtime whose journal lives in `stateDir`; `null` means the record was removed. */
    observe(stateDir: string, record: TaskRecord | null): void {
      if (closed) return
      if (record === null) {
        schedule([...sessionDirs].filter(([, dir]) => dir === stateDir).map(([sessionID]) => sessionID))
        return
      }
      learn(stateDir, record)
      schedule([record.parent_session_id, record.root_session_id])
    },
    async settled(): Promise<void> {
      flush()
      await Promise.allSettled([...chains.values()])
    },
    close(): void {
      closed = true
      events = undefined
      if (timer !== undefined) clearTimeout(timer)
      timer = undefined
      pending.clear()
      published.clear()
      for (const store of stores.values()) store.close()
      stores.clear()
    },
  }
}

export type TaskStatusRpc = ReturnType<typeof createTaskStatusRpc>
