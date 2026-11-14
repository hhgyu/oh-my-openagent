import { afterEach, describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { discoverLeftBehindParents } from "./left-behind-discovery"
import { nativeTaskStateDir } from "./state-dir"

const projects: string[] = []
afterEach(() => {
  for (const project of projects.splice(0)) rmSync(project, { recursive: true, force: true })
})

function project(): string {
  const directory = mkdtempSync(join(tmpdir(), "omo-left-behind-"))
  projects.push(directory)
  return directory
}

function record(directory: string, root: string, id: string, extra: Record<string, unknown> = {}, storeRoot = root) {
  const tasks = join(nativeTaskStateDir(directory, storeRoot), "tasks")
  mkdirSync(tasks, { recursive: true })
  writeFileSync(
    join(tasks, `${id}.json`),
    JSON.stringify({
      task_id: id,
      // The store's on-disk shape of an owned child (storable-record.ts).
      runner_kind: "host-session",
      owned_session: { sessionID: `child-${id}` },
      status: "running",
      residency_state: "resident",
      host_pid: 1,
      parent_session_id: root,
      root_session_id: root,
      depth: 1,
      ...extra,
    }),
  )
}

describe("#given the task state a previous OpenCode process left in a project", () => {
  test("#when the restarted host looks for left-behind children #then only live children no current host owns are found, nearest the root first", () => {
    // given
    const directory = project()
    record(directory, "ses_root", "st_running")
    record(directory, "ses_root", "st_parked", { residency_state: "persisted_only" })
    record(directory, "ses_root", "st_nested", { parent_session_id: "child-st_running", depth: 2 })
    record(directory, "ses_root", "st_done", { status: "completed" })
    record(directory, "ses_root", "st_mine", { host_pid: 4242 })
    record(directory, "ses_root", "st_killed", { killed: true })
    record(directory, "ses_root", "st_daemon", { owned_session: undefined, host_session: { socket: "s" } })
    record(directory, "ses_other", "st_misplaced", {}, "ses_root")

    // when
    const parents = discoverLeftBehindParents(directory, 4242)

    // then
    expect(parents).toEqual([
      { sessionID: "ses_root", depth: 1, tasks: expect.arrayContaining(["st_running", "st_parked"]) },
      { sessionID: "child-st_running", depth: 2, tasks: ["st_nested"] },
    ])
    expect(parents[0]?.tasks).toHaveLength(2)
  })

  test("#when the project has no task state #then nothing is found", () => {
    expect(discoverLeftBehindParents(project())).toEqual([])
  })
})
