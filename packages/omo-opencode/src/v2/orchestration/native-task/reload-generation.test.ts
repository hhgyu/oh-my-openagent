import { describe, expect, test } from "bun:test"
import { join } from "node:path"
import { Database } from "bun:sqlite"
import { withNativeOperationService } from "./service.test"

type Fixture = Parameters<Parameters<typeof withNativeOperationService>[0]>[0]

function storedGeneration(f: Fixture, journalKey: string): number {
  const db = new Database(join(f.dir, "parent", "owned-children.sqlite"), { readonly: true })
  try {
    const row = db.query("SELECT body FROM children WHERE key=?").get(journalKey) as { body: string } | null
    if (!row) throw Error("Missing stored child row")
    return JSON.parse(row.body).locator.generation
  } finally { db.close() }
}

describe("#given a finished child whose row was stored at a lease generation above a fresh scope's", () => {
  test("#when the plugin reloads with fresh session scopes and the parent recovers it #then the generation only rises and recovery succeeds", async () => {
    await withNativeOperationService(async f => {
      // given: four other root sessions open leases first, so the parent's lease generation is 5
      for (const other of ["ses_gen_a", "ses_gen_b", "ses_gen_c", "ses_gen_d"]) await f.invoke(async () => null, f.raw(other))
      const parent = f.raw()
      const start = await f.invoke(api => api.start({ category: "qa", prompt: "generation five", run_in_background: true }), parent)
      if (start.kind !== "started") throw Error(`start: ${start.kind}`)
      const before = await f.invoke(api => api.wait(start.task_id), parent)
      expect(storedGeneration(f, before.owned_session.journalKey)).toBe(5)
      // when
      await f.reload()
      const recovered = await f.invoke(api => api.recover(start.task_id), f.raw()).then(record => record, (error: unknown) => error instanceof AggregateError ? `${error.message}: ${error.errors.map(String).join("; ")}` : String(error))
      // then
      expect(String(recovered)).not.toContain("Child locator identity cannot change")
      expect(recovered).toMatchObject({ task_id: start.task_id, status: "completed", child_session_id: before.child_session_id })
      expect(storedGeneration(f, before.owned_session.journalKey)).toBeGreaterThanOrEqual(5)
    })
  })
})
