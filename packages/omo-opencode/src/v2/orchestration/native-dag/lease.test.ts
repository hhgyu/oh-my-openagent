import { afterEach, describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  createDagFileStore,
  createDagManager,
  type DagRunId,
  type DagRunRecordV1,
} from "@oh-my-opencode/senpi-task/dag"
import { claimDagRunLease, createNativeDagGenerationLease, type NativeDagGenerationLease } from "./lease"
import { NativeDagRefusal } from "./refusals"

type Leased = DagRunRecordV1 & { readonly leaseHolderPid?: number }
const PARENT = "ses_dag_lease_root"
const OTHER_PID = 4242
const roots: string[] = [],
  leases: NativeDagGenerationLease[] = []
afterEach(() => {
  for (const lease of leases.splice(0)) lease.dispose()
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})
function lease(options?: Parameters<typeof createNativeDagGenerationLease>[0]): NativeDagGenerationLease {
  const created = createNativeDagGenerationLease(options)
  leases.push(created)
  return created
}

/** A running run whose checkpoint names `holder` as its lease holder. */
async function runHeldBy(holder: number) {
  const directory = mkdtempSync(join(tmpdir(), "omo-v2-dag-lease-"))
  roots.push(directory)
  const store = createDagFileStore({ project_dir: directory, task: { state_dir: join(directory, "state") } })
  const manager = createDagManager({ store })
  const started = await manager.start({
    parentSessionId: PARENT,
    rootSessionId: PARENT,
    definition: { key: "lease", name: "lease", nodes: [{ id: "a", prompt: "do a", category: "quick" }] },
  })
  const runId: DagRunId = started.snapshot.runId
  store.withRunLock(runId, () => {
    store.writeCheckpoint(runId, { ...manager.record(runId, PARENT), status: "running", leaseHolderPid: holder })
  })
  return { store, runId, holder: (): number | undefined => manager.record(runId, PARENT).leaseHolderPid }
}

describe("OpenCode 2 DAG generation lease holder", () => {
  test("#given a generation of this process #then its holder is a safe integer above every pid, and it reads live until that generation retires", () => {
    // given
    const own = lease(),
      sibling = lease()

    // then
    expect(Number.isSafeInteger(own.holder())).toBe(true)
    expect(own.holder()).toBeGreaterThanOrEqual(2 ** 52)
    expect(own.isAlive(sibling.holder())).toBe(true)
    sibling.dispose()
    expect(own.isAlive(sibling.holder())).toBe(false)
  })

  test("#given a holder of another process #then it reads live exactly while that pid is alive", () => {
    // given
    const foreign = lease({ pid: OTHER_PID })
    let alive = true
    const own = lease({ isProcessAlive: (pid) => pid === OTHER_PID && alive })

    // then
    expect(own.isAlive(foreign.holder())).toBe(true)
    alive = false
    expect(own.isAlive(foreign.holder())).toBe(false)
  })

  test("#given a number this encoding never issued (a pre-encoding holder or a plain pid) #then it reads as stale", () => {
    const own = lease({ isProcessAlive: () => true })
    expect(own.isAlive(2 ** 41 + 7)).toBe(false)
    expect(own.isAlive(process.pid)).toBe(false)
  })
})

describe("OpenCode 2 DAG run lease claim", () => {
  test("#given a running run another live OpenCode process holds #when this generation claims it #then it refuses with run_still_active and leaves the holder in place", async () => {
    // given
    const foreign = lease({ pid: OTHER_PID })
    const { store, runId, holder } = await runHeldBy(foreign.holder())
    const own = lease({ isProcessAlive: (pid) => pid === OTHER_PID })

    // when
    const claim = (() => {
      try {
        return claimDagRunLease(store, runId, own)
      } catch (error) {
        return error
      }
    })()

    // then
    expect(claim instanceof NativeDagRefusal && claim.code).toBe("run_still_active")
    expect(holder()).toBe(foreign.holder())
  })

  test("#given a running run whose holder's process is dead #when this generation claims and releases it #then it drives meanwhile and writes that holder back", async () => {
    // given
    const foreign = lease({ pid: OTHER_PID })
    const { store, runId, holder } = await runHeldBy(foreign.holder())
    const own = lease({ isProcessAlive: () => false })

    // when
    const release = claimDagRunLease(store, runId, own)
    const during = holder()
    release()

    // then
    expect(during).toBe(own.holder())
    expect(holder()).toBe(foreign.holder())
  })
})
