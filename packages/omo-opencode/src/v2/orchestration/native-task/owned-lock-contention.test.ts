import { describe, expect, test } from "bun:test"
import { rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { withOwnedRuntimeUnit } from "./runtime.test"

describe("#given an owned child whose final answer lands while another writer holds its task record lock", () => {
  test("#when the lock is released a few seconds later #then the task settles once as completed without a restart", async () => {
    await withOwnedRuntimeUnit(async (runtime, state) => {
      // given
      const start = await runtime.start({ category: "qa", prompt: "block-until-interrupt" })
      if (start.kind !== "started") throw Error(JSON.stringify(start))
      for (let attempt = 0; attempt < 400 && !state.hostActive(); attempt++) await Bun.sleep(5)
      const lock = join(runtime.store.stateDir, "tasks", `${start.task_id}.json.lock`)
      writeFileSync(lock, `${process.pid}\n${Date.now()}\nlock-contention-holder\n`, { flag: "wx" })

      // when
      state.finishFrame(String(runtime.get(start.task_id)?.child_session_id))
      await Bun.sleep(2500)
      const whileHeld = runtime.get(start.task_id)
      rmSync(lock, { force: true })
      const settled = await runtime.wait(start.task_id, AbortSignal.timeout(20_000))

      // then
      expect(whileHeld?.status).toBe("running")
      expect(settled.status).toBe("completed")
      expect(settled.final_response).toBe("after managed inputs")
      expect(settled.notification.run_epoch).toBe(0)
      expect(settled.observation_uncertain).toBeUndefined()
    })
  }, 40_000)
})
