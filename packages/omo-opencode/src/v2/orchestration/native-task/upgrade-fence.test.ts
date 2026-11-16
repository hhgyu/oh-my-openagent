import { describe, expect, test } from "bun:test"
import { readFileSync, renameSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import type { TaskOutputInput } from "@oh-my-opencode/senpi-task/manager-kernel"
import { runTaskOutput } from "@oh-my-opencode/senpi-task/task-operations"
import { withNativeOperationService } from "./service.test"
import { upgradeLostReason, upgradeNoticeDue } from "./upgrade-fence"

type Fixture = Parameters<Parameters<typeof withNativeOperationService>[0]>[0]

function recordPath(f: Fixture, id: string): string {
  return join(f.dir, "parent", "tasks", `${id}.json`)
}

function reshape(f: Fixture, id: string, change: (record: Record<string, unknown>) => Record<string, unknown>) {
  const path = recordPath(f, id)
  const staged = `${path}.edit-${process.pid}`
  writeFileSync(staged, JSON.stringify(change(JSON.parse(readFileSync(path, "utf8")))))
  renameSync(staged, path)
}

function stored(f: Fixture, id: string) {
  return JSON.parse(readFileSync(recordPath(f, id), "utf8")) as {
    status: string
    notification: { run_epoch: number; notified_epoch: number }
  }
}

function upgradeNotices(f: Fixture) {
  return f.synthetics
    .map((entry) => entry.input as { metadata?: { omoTaskHostUpgrade?: string } })
    .map((input) => input.metadata?.omoTaskHostUpgrade)
    .filter((id): id is string => id !== undefined)
}

async function readOutput(f: Fixture, input: TaskOutputInput) {
  const parent = f.raw("parent")
  return (await f.invoke(
    (api) =>
      api.operation(async (_manager, _ancestry, _signal, owner) =>
        runTaskOutput({ manager: owner.output, stateDir: join(f.dir, "parent") }, input, "parent"),
      ),
    parent,
  )) as {
    details: {
      kind?: string
      known_tasks?: string[]
      snapshot?: { task_id: string; status: string }
    }
  }
}

async function restoreLeftBehind(f: Fixture) {
  return f.invoke(
    (api) => api.operation(async (_manager, _ancestry, _signal, owner) => owner.recovery.restoreLeftBehind()),
    f.raw("parent"),
  )
}

describe("#given children a parent started under OpenCode 2.2.6", () => {
  test("#when the host is upgraded and a child is ended as lost #then task_output reads it by id and by name and the not-found hint lists it", async () => {
    await withNativeOperationService(async (f) => {
      // given
      const root = f.raw()
      const old = await f.invoke(
        (api) =>
          api.start({
            category: "qa",
            prompt: "block",
            run_in_background: true,
            name: "fenced-child",
          }),
        root,
      )
      await f.reload("2.3.0")
      await expect(f.invoke((api) => api.recover(old.task_id), f.raw("parent"))).rejects.toThrow(
        "fenced to an earlier OpenCode version",
      )

      // when
      const byId = await readOutput(f, { task_id: old.task_id })
      const byName = await readOutput(f, { name: "fenced-child" })
      const missing = await readOutput(f, { task_id: "st_missing" })

      // then
      expect(byId.details.snapshot).toMatchObject({ task_id: old.task_id, status: "lost" })
      expect(byName.details.snapshot).toMatchObject({ task_id: old.task_id, status: "lost" })
      expect(missing.details.kind).toBe("not_found")
      expect(missing.details.known_tasks).toEqual(["fenced-child"])
    })
  })

  test("#when one batch is fenced by the upgrade #then every member whose end the parent never heard gets exactly one notice", async () => {
    await withNativeOperationService(async (f) => {
      // given: one batch of four; after the upgrade one had already ended interrupted under 2.2.6 with no
      // delivered notice, and one was already ended lost (with its notice) by an earlier build.
      const root = f.raw()
      const ids: string[] = []
      for (const name of ["running-a", "running-b", "interrupted-c", "noticed-d"]) {
        const started = await f.invoke(
          (api) => api.start({ category: "qa", prompt: "block", run_in_background: true, name }),
          root,
        )
        ids.push(started.task_id)
      }
      const [a, b, c, d] = ids as [string, string, string, string]
      await f.reload("2.3.0")
      const terminalAt = new Date().toISOString()
      reshape(f, c, (record) => ({ ...record, status: "interrupted", terminal_at: terminalAt }))
      reshape(f, d, (record) => ({
        ...record,
        status: "lost",
        terminal_at: terminalAt,
        error_message: upgradeLostReason("2.2.6", "2.3.0"),
      }))

      // when: two acting calls of the parent each restore what the restart left behind
      await restoreLeftBehind(f)
      await restoreLeftBehind(f)

      // then
      expect(upgradeNotices(f).toSorted()).toEqual([a, b, c].toSorted())
      expect(stored(f, a).status).toBe("lost")
      expect(stored(f, b).status).toBe("lost")
      expect(stored(f, c).status).toBe("interrupted")
      for (const id of [a, b, c, d]) {
        const { notification } = stored(f, id)
        expect(notification.notified_epoch).toBe(notification.run_epoch)
      }
      const listed = await readOutput(f, { task_id: "st_missing" })
      expect(listed.details.known_tasks?.toSorted()).toEqual(
        ["running-a", "running-b", "interrupted-c", "noticed-d"].toSorted(),
      )
    })
  })
})

describe("upgradeNoticeDue", () => {
  const base = {
    status: "running",
    notify_on_terminal: true,
    notification: { run_epoch: 1, notified_epoch: -1 },
    owned_session: { hostVersion: "2.2.6" },
  }

  test("#given a child of the current host #then nothing is owed", () => {
    expect(upgradeNoticeDue({ ...base, owned_session: { hostVersion: "2.3.0" } }, "2.3.0")).toBeUndefined()
  })

  test("#given fenced children #then each state maps to what the parent is still owed", () => {
    expect(upgradeNoticeDue(base, "2.3.0")).toBe("active")
    expect(upgradeNoticeDue({ ...base, status: "interrupted" }, "2.3.0")).toBe("terminal")
    expect(upgradeNoticeDue({ ...base, status: "completed" }, "2.3.0")).toBe("terminal")
    expect(
      upgradeNoticeDue({ ...base, status: "lost", error_message: upgradeLostReason("2.2.6", "2.3.0") }, "2.3.0"),
    ).toBe("noticed")
    expect(upgradeNoticeDue({ ...base, status: "cancelled" }, "2.3.0")).toBeUndefined()
    expect(upgradeNoticeDue({ ...base, status: "completed", killed: true }, "2.3.0")).toBeUndefined()
    expect(upgradeNoticeDue({ ...base, status: "completed", notify_on_terminal: false }, "2.3.0")).toBeUndefined()
    expect(
      upgradeNoticeDue({ ...base, status: "completed", notification: { run_epoch: 1, notified_epoch: 1 } }, "2.3.0"),
    ).toBeUndefined()
  })
})
