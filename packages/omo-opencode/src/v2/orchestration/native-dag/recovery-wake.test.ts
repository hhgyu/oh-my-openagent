import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createHash } from "node:crypto"
import { openDagDeliveryJournal } from "../../host/dag-delivery-journal"
import { discoverDagRoots } from "./discovery"
import { createNativeDagGenerationLease } from "./lease"
import { createWorkflowHarness } from "./test-support"
import { dagWakeInputId } from "./wake-projection"

setDefaultTimeout(process.platform === "win32" ? 60_000 : 20_000)

const PARENT = "ses_dag_recovery_wake_root"
const roots: string[] = [],
  cleanups: (() => Promise<void> | void)[] = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

const settle = () => new Promise((resolve) => setTimeout(resolve, 50))
const node = (id: string, dependsOn?: readonly string[]) => ({
  id,
  prompt: `do ${id}`,
  category: "quick",
  ...(dependsOn && { dependsOn }),
})

function generation(directory: string, inherited: ReturnType<typeof createWorkflowHarness>["fakes"] = []) {
  const lease = createNativeDagGenerationLease()
  const dag = createWorkflowHarness(directory, lease, PARENT, inherited)
  cleanups.push(
    () => dag.wake.close(),
    () => lease.dispose(),
  )
  return { lease, dag }
}

/** A detached run whose node "a" settled while no call was in progress, and whose wake intent was
 * journaled but never ACKed (transport down), then the component closed: children parked, runs
 * paused, generation retired. The next generation re-arms its wake owner the way the component's
 * startup does (discovered roots, every live run armed). */
async function reloadWithUnackedWake() {
  const directory = mkdtempSync(join(tmpdir(), "omo-v2-dag-recovery-wake-"))
  roots.push(directory)
  const first = generation(directory)
  const { result, fake } = await first.dag.call({
    action: "start",
    detach: true,
    definition: { key: "wake", name: "wake", nodes: [node("a"), node("b", ["a"])] },
  })
  const runId = result.details.kind === "started" ? result.details.run_id : ""
  first.dag.state.failSynthetic = true
  fake.complete("a")
  await first.dag.wake.refresh()
  for (const earlier of first.dag.fakes) earlier.park()
  await first.dag.runtime.pauseForShutdown()
  await first.dag.wake.close()
  first.lease.dispose()
  const second = generation(directory, first.dag.fakes)
  for (const root of discoverDagRoots(directory)) {
    for (const run of second.dag.runtime.manager.list(root)) second.dag.wake.arm(root, run.runId)
  }
  return { directory, first, second, runId }
}

describe("OpenCode 2 workflow wake across a reload", () => {
  test("#given an un-ACKed wake when the plugin reloaded #when the next generation's wake owner runs #then it re-posts that wake once with the same id", async () => {
    // given
    const { directory, first, second, runId } = await reloadWithUnackedWake()
    const id = dagWakeInputId(runId, { settled: [{ nodeId: "a", taskId: "task-1", runEpoch: 1, status: "completed" }] })
    const journal = openDagDeliveryJournal({
      path: join(directory, "dag-wakes.sqlite"),
      namespace:
        "opencode2-dag:" +
        createHash("sha256")
          .update(JSON.stringify([directory, PARENT]))
          .digest("hex"),
    })
    cleanups.push(() => journal.close())
    const before = journal.findInput(runId, id)

    // when
    await second.dag.wake.refresh()
    await second.dag.wake.refresh()

    // then
    expect(first.dag.posts).toEqual([])
    expect(before?.phase).toBe("intent")
    expect(second.dag.posts).toEqual([id])
    expect(journal.findInput(runId, id)).toMatchObject({ phase: "acked", seq: before?.seq, text: before?.text })
  })

  test("#given a reloaded generation with a paused run #when only its wake owner runs and time passes #then nothing is started, restored or resumed without a call", async () => {
    // given
    const { directory, second, runId } = await reloadWithUnackedWake()

    // when
    await second.dag.wake.refresh()
    await settle()

    // then
    expect(discoverDagRoots(directory)).toEqual([PARENT])
    expect(second.dag.record(runId).status).toBe("paused")
    expect(second.dag.fakes.flatMap((fake) => fake.starts.map((start) => start.nodeId))).toEqual(["a"])
    expect(second.dag.fakes.flatMap((fake) => fake.restored)).toEqual([])
    expect(second.dag.runtime.driving()).toBe(0)
  })
})
