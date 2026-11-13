import { describe, expect, test } from "bun:test"
import { existsSync } from "node:fs"
import { join } from "node:path"
import { Database } from "bun:sqlite"
import type { ToolContext } from "@opencode/plugin/promise/tool"
import { withNativeOperationService } from "./service.test"

type Fixture = Parameters<Parameters<typeof withNativeOperationService>[0]>[0]
type Origin = ReturnType<Fixture["raw"]>

function failure(error: unknown): string {
  return error instanceof AggregateError ? `${error.message}: ${error.errors.map(String).join("; ")}` : String(error)
}

function hostSubagent(f: Fixture, id = "ses_host_sub", parentID = "parent"): Origin {
  f.raw(parentID)
  return f.raw(id, { parentID })
}

async function ownedChild(f: Fixture, root: Origin, prompt = "block") {
  const start = await f.invoke((api) => api.start({ category: "qa", prompt }), root)
  if (start.kind !== "started") throw Error(`start: ${start.kind}`)
  const row = await f.invoke((api) => Promise.resolve(api.get(start.task_id)), root)
  const caller = { ...root.caller, sessionID: row.child_session_id } as ToolContext
  return { start, row, child: { caller, controller: root.controller } }
}

describe("#given a session the host created with a parentID that no OmO runtime owns", () => {
  test("#when it calls task #then it owns a root lease and its OmO child completes under it", async () => {
    await withNativeOperationService(async (f) => {
      // given
      const host = hostSubagent(f)
      // when
      const start = await f.invoke((api) => api.start({ category: "qa", prompt: "from host subagent" }), host)
      // then
      expect(start.kind).toBe("started")
      const done = await f.invoke((api) => api.wait(start.task_id), host)
      expect(done).toMatchObject({
        status: "completed",
        root_session_id: "ses_host_sub",
        parent_session_id: "ses_host_sub",
        depth: 1,
      })
      expect((await f.ctx.session.get({ sessionID: done.child_session_id })).parentID).toBe("ses_host_sub")
      expect(existsSync(join(f.dir, "ses_host_sub", "owned-children.sqlite"))).toBe(true)
      expect(existsSync(join(f.dir, "parent"))).toBe(false)
      const again = await f.invoke((api) => Promise.resolve(api.get(start.task_id)), host)
      expect(again.status).toBe("completed")
    })
  })

  test("#when its background child completes after it went idle #then the completion notice reaches it", async () => {
    await withNativeOperationService(async (f) => {
      // given
      const host = hostSubagent(f)
      const start = await f.invoke(
        (api) => api.start({ category: "qa", prompt: "block host notice", run_in_background: true }),
        host,
      )
      const running = await f.invoke((api) => Promise.resolve(api.get(start.task_id)), host)
      await f.idle("ses_host_sub")
      f.enableParentQuiescence("ses_host_sub")
      // when
      f.finishChild(running.child_session_id, "host subagent completion")
      // then
      const deadline = Date.now() + 2000
      while (f.synthetics.length === 0 && Date.now() < deadline) await Bun.sleep(5)
      expect(f.synthetics).toHaveLength(1)
      expect(f.synthetics[0]?.input.sessionID).toBe("ses_host_sub")
      expect(f.synthetics[0]?.input.text).toContain("host subagent completion")
    })
  })

  test("#when its OmO child goes past max_depth #then the depth limit still refuses", async () => {
    await withNativeOperationService(async (f) => {
      // given
      f.setMaxDepth(1)
      const host = hostSubagent(f)
      const { start, child } = await ownedChild(f, host)
      // when
      const refused = await f.invoke((api) => api.start({ category: "qa", prompt: "too deep" }), child)
      // then
      expect(refused).toMatchObject({ kind: "depth_denied", child_depth: 2, max_depth: 1 })
      await f.invoke((api) => api.end(start.task_id), host)
    })
  })

  test("#when the plugin reloads #then the same host session owns its root again and recovers its child", async () => {
    await withNativeOperationService(async (f) => {
      // given
      const host = hostSubagent(f)
      const start = await f.invoke(
        (api) => api.start({ category: "qa", prompt: "before reload", run_in_background: true }),
        host,
      )
      if (start.kind !== "started") throw Error(`start: ${start.kind}`)
      const before = await f.invoke((api) => api.wait(start.task_id), host)
      // when
      await f.reload()
      const recovered = await f
        .invoke((api) => api.recover(start.task_id), hostSubagent(f))
        .then(
          (record) => record,
          (error: unknown) => failure(error),
        )
      // then
      expect(recovered).toMatchObject({
        task_id: start.task_id,
        status: "completed",
        child_session_id: before.child_session_id,
      })
      const next = await f.invoke((api) => api.start({ category: "qa", prompt: "after reload" }), hostSubagent(f))
      expect(next.kind).toBe("started")
      expect(await f.invoke((api) => api.wait(next.task_id), hostSubagent(f))).toMatchObject({
        status: "completed",
        root_session_id: "ses_host_sub",
      })
    })
  })

  test("#when an ancestor lives in another directory #then ownership cannot be verified and it is refused", async () => {
    await withNativeOperationService(async (f) => {
      // given
      f.raw("ses_foreign_parent", { directory: join(f.dir, "elsewhere") })
      const host = f.raw("ses_host_sub", { parentID: "ses_foreign_parent" })
      // when
      const result = await f.service.parent(host.caller).then(
        () => "minted",
        (error: unknown) => failure(error),
      )
      // then
      expect(result).toContain("Host subagent ownership cannot be verified")
      expect(existsSync(join(f.dir, "ses_host_sub"))).toBe(false)
    })
  })

  test("#when an ancestor's child journal has an unreadable row #then ownership is unknown and it is refused", async () => {
    await withNativeOperationService(async (f) => {
      // given
      const root = f.raw()
      const done = await f.invoke(
        (api) => api.start({ category: "qa", prompt: "journal owner", run_in_background: true }),
        root,
      )
      await f.invoke((api) => api.wait(done.task_id), root)
      await f.reload()
      const db = new Database(join(f.dir, "parent", "owned-children.sqlite"))
      try {
        db.query("INSERT INTO children (key, body) VALUES (?, ?)").run("corrupt", "{not json")
      } finally {
        db.close()
      }
      const host = f.raw("ses_host_sub", { parentID: "parent" })
      // when
      const result = await f.service.parent(host.caller).then(
        () => "minted",
        (error: unknown) => failure(error),
      )
      // then
      expect(result).toContain("Host subagent ownership cannot be verified")
      expect(existsSync(join(f.dir, "ses_host_sub"))).toBe(false)
    })
  })
})

describe("#given an OmO-owned child session", () => {
  test("#when it calls task while its root is live #then it stays nested under its owning root", async () => {
    await withNativeOperationService(async (f) => {
      // given
      const root = f.raw()
      const { start, child } = await ownedChild(f, root)
      // when
      const grand = await f.invoke(
        (api) => api.start({ category: "qa", prompt: "grandchild", run_in_background: true }),
        child,
      )
      // then
      const done = await f.invoke((api) => api.wait(grand.task_id), root)
      expect(done).toMatchObject({ status: "completed", root_session_id: "parent", depth: 2 })
      expect(existsSync(join(f.dir, String(child.caller.sessionID)))).toBe(false)
      await f.invoke((api) => api.end(start.task_id), root)
    })
  })

  test("#when it calls task after a reload before its root is active #then it is refused and never promoted to a root", async () => {
    await withNativeOperationService(async (f) => {
      // given
      const root = f.raw()
      const { child } = await ownedChild(f, root)
      await f.reload()
      // when
      const result = await f.service.parent(child.caller).then(
        () => "minted",
        (error: unknown) => failure(error),
      )
      // then
      expect(result).toContain("Nested caller has no unique owned root manager")
      expect(existsSync(join(f.dir, String(child.caller.sessionID)))).toBe(false)
    })
  })

  test("#when a host subagent created under it calls task #then it is refused so OmO depth cannot reset", async () => {
    await withNativeOperationService(async (f) => {
      // given
      const root = f.raw()
      const { child } = await ownedChild(f, root)
      const underChild = f.raw("ses_host_under_child", { parentID: child.caller.sessionID })
      // when
      const live = await f.service.parent(underChild.caller).then(
        () => "minted",
        (error: unknown) => failure(error),
      )
      await f.reload()
      const reloaded = await f.service.parent(underChild.caller).then(
        () => "minted",
        (error: unknown) => failure(error),
      )
      // then
      expect(live).toContain("Host subagent under an OmO-owned session")
      expect(reloaded).toContain("Host subagent under an OmO-owned session")
      expect(existsSync(join(f.dir, "ses_host_under_child"))).toBe(false)
    })
  })
})
