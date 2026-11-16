import { existsSync, readdirSync, readFileSync } from "node:fs"
import { homedir } from "node:os"
import { join, resolve } from "node:path"
import { nativeTaskStateDir } from "./state-dir"
import { upgradeNoticeDue } from "./upgrade-fence"

const LEFT_BEHIND_STATUSES = new Set(["running", "pending", "paused"])
const TASK_FILE = /^(st_[0-9a-z]+)\.json$/

/** A session whose owned children a previous host process left behind, nearest the root first. */
export interface LeftBehindParent {
  readonly sessionID: string
  readonly depth: number
  readonly tasks: readonly string[]
}

function field(value: unknown, key: string): unknown {
  return typeof value === "object" && value !== null ? Reflect.get(value, key) : undefined
}

/** The task store writes an owned child as R0's `host-session` kind plus its `owned_session` reference
 * (`storable-record.ts`); the parser restores `owned-session` only for that exact pair. */
function ownedOnDisk(record: unknown): boolean {
  const kind = field(record, "runner_kind")
  return (
    (kind === "host-session" || kind === "owned-session") &&
    typeof field(record, "owned_session") === "object" &&
    field(record, "host_session") === undefined &&
    field(record, "pid") === undefined
  )
}

function fencedOnDisk(record: unknown, hostVersion: string): boolean {
  const notification = field(record, "notification"),
    runEpoch = field(notification, "run_epoch"),
    notifiedEpoch = field(notification, "notified_epoch"),
    failedEpoch = field(notification, "notification_failed_epoch"),
    fencedTo = field(field(record, "owned_session"), "hostVersion"),
    status = field(record, "status"),
    error = field(record, "error_message")
  if (
    typeof runEpoch !== "number" ||
    typeof notifiedEpoch !== "number" ||
    typeof fencedTo !== "string" ||
    typeof status !== "string"
  )
    return false
  const facts = {
    status,
    killed: field(record, "killed") === true,
    notify_on_terminal: field(record, "notify_on_terminal") === true,
    ...(typeof error === "string" && { error_message: error }),
    notification: {
      run_epoch: runEpoch,
      notified_epoch: notifiedEpoch,
      ...(typeof failedEpoch === "number" && { notification_failed_epoch: failedEpoch }),
    },
    owned_session: { hostVersion: fencedTo },
  }
  return upgradeNoticeDue(facts, hostVersion) !== undefined
}

/** Native revives a session's suspended children at `session_start` (`revival-selection.ts`). This finds
 * the sessions that need it after an OpenCode restart: an owned child still running, pending or paused
 * that a previous host either parked (persisted only) or left resident under another process. Every
 * record must live in the state directory its own root session hashes to, so a record cannot name a
 * parent whose storage lives elsewhere. Whether the old host is really gone, and whether the child may
 * be revived, is decided by the restore itself. Never scans when the project directory is $HOME.
 * Given the current host version, a child an upgrade fenced before its parent heard how it ended is found
 * too, whatever its status, so its parent gets that one notice at startup (D-042). */
export function discoverLeftBehindParents(
  projectDirectory: string,
  hostPid = process.pid,
  hostVersion?: string,
): LeftBehindParent[] {
  if (resolve(projectDirectory) === resolve(homedir())) return []
  const root = join(projectDirectory, ".omo", "tasks", "opencode-v2")
  if (!existsSync(root)) return []
  const parents = new Map<string, { depth: number; tasks: string[] }>()
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory() || !/^[0-9a-f]{64}$/.test(entry.name)) continue
    const stateDir = join(root, entry.name)
    const tasksDir = join(stateDir, "tasks")
    if (!existsSync(tasksDir)) continue
    for (const file of readdirSync(tasksDir)) {
      const id = TASK_FILE.exec(file)?.[1]
      if (!id) continue
      let record: unknown
      try {
        record = JSON.parse(readFileSync(join(tasksDir, file), "utf8"))
      } catch {
        continue
      }
      const parent = field(record, "parent_session_id"),
        rootSession = field(record, "root_session_id"),
        depth = field(record, "depth"),
        residency = field(record, "residency_state")
      if (
        field(record, "task_id") !== id ||
        !ownedOnDisk(record) ||
        typeof parent !== "string" ||
        typeof rootSession !== "string" ||
        typeof depth !== "number" ||
        nativeTaskStateDir(projectDirectory, rootSession) !== stateDir
      )
        continue
      const fenced = hostVersion !== undefined && fencedOnDisk(record, hostVersion)
      const live = field(record, "killed") !== true && LEFT_BEHIND_STATUSES.has(String(field(record, "status")))
      const leftBehind =
        residency === "persisted_only" || (residency === "resident" && field(record, "host_pid") !== hostPid)
      if (!fenced && !(live && leftBehind)) continue
      const known = parents.get(parent) ?? { depth, tasks: [] }
      known.depth = Math.min(known.depth, depth)
      known.tasks.push(id)
      parents.set(parent, known)
    }
  }
  return [...parents]
    .map(([sessionID, value]) => Object.freeze({ sessionID, depth: value.depth, tasks: Object.freeze(value.tasks) }))
    .sort((a, b) => a.depth - b.depth || a.sessionID.localeCompare(b.sessionID))
}
