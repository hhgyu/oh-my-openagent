import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { DagRunRecordV1 } from "@oh-my-opencode/senpi-task/dag"
import { createNativeDagGenerationLease, type NativeDagGenerationLeaseOptions } from "./lease"
import { createWorkflowHarness } from "./test-support"

export const RECOVERY_PARENT = "ses_dag_recovery_root"
export type Leased = DagRunRecordV1 & { readonly leaseHolderPid?: number; readonly previousLeaseHolderPid?: number }
export const node = (id: string, dependsOn?: readonly string[]) => ({
  id,
  prompt: `do ${id}`,
  category: "quick",
  ...(dependsOn && { dependsOn: [...dependsOn] }),
})

/** Plugin generations over temporary project directories, for the DAG recovery tests. `cleanup`
 * closes every generation and removes every directory; a test file runs it after each test. */
export function createRecoveryFixture() {
  const roots: string[] = [],
    cleanups: (() => Promise<void> | void)[] = []
  /** One plugin generation over `directory`: its own generation lease and harness, sharing the
   * earlier generation's children. `dispose` is the component close: the service aborts the call
   * and parks every child, then the runtime pauses its runs and the generation retires. `kill` is a
   * hard kill: every child is stranded (parked, owned by no runtime) and nothing is paused.
   * `leaseOptions` makes it the generation of another OpenCode process (its pid, and which pids
   * that process sees alive). */
  function generation(
    directory: string,
    inherited: ReturnType<typeof createWorkflowHarness>["fakes"] = [],
    leaseOptions?: NativeDagGenerationLeaseOptions,
  ) {
    const lease = createNativeDagGenerationLease(leaseOptions)
    const dag = createWorkflowHarness(directory, lease, RECOVERY_PARENT, inherited)
    cleanups.push(
      () => dag.wake.close(),
      () => lease.dispose(),
    )
    return {
      lease,
      dag,
      async dispose(stop?: AbortController) {
        stop?.abort(Error("Native task component closed"))
        for (const fake of dag.fakes) fake.park()
        const paused = await dag.runtime.pauseForShutdown()
        await dag.wake.close()
        lease.dispose()
        return paused
      },
      async kill() {
        for (const fake of dag.fakes) fake.park()
        await dag.wake.close()
        lease.dispose()
      },
    }
  }
  async function startDriven(directory: string) {
    const first = generation(directory)
    const stop = new AbortController()
    const { fake, pending } = first.dag.begin(
      { action: "start", definition: { key: "s6f", name: "s6f", nodes: [node("a"), node("b", ["a"])] } },
      { signal: stop.signal },
    )
    await fake.whenStarted("a")
    void pending.catch(() => {})
    const runId = first.dag.runtime.manager.list(RECOVERY_PARENT)[0]?.runId ?? ""
    return { first, stop, fake, pending, runId }
  }
  function fresh() {
    const directory = mkdtempSync(join(tmpdir(), "omo-v2-dag-recovery-"))
    roots.push(directory)
    return directory
  }
  async function cleanup() {
    for (const close of cleanups.splice(0).reverse()) await close()
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
  }
  return { generation, startDriven, fresh, cleanup }
}
