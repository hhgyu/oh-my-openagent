import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test"
import type { DagRunId } from "@oh-my-opencode/senpi-task/dag"
import { RECOVERY_PARENT, createRecoveryFixture, node, type Leased } from "./recovery-fixture"

setDefaultTimeout(process.platform === "win32" ? 60_000 : 20_000)

const { generation, startDriven, fresh, cleanup } = createRecoveryFixture()
afterEach(cleanup)

describe("OpenCode 2 workflow recovery after a reload", () => {
  test("#given a run a call is driving #when the component closes #then the run is paused with this generation's lease and no child is cancelled", async () => {
    // given
    const { first, stop, fake, pending, runId } = await startDriven(fresh())

    // when
    const paused = await first.dispose(stop)

    // then
    expect(
      await pending.then(
        () => "returned",
        () => "aborted",
      ),
    ).toBe("aborted")
    expect(paused).toEqual([runId as DagRunId])
    const record: Leased = first.dag.record(runId)
    expect(record.status).toBe("paused")
    expect(record.pause).toBeUndefined()
    expect(record.leaseHolderPid).toBeUndefined()
    expect(record.previousLeaseHolderPid).toBe(first.lease.holder())
    expect(fake.cancelled).toEqual([])
    expect(fake.tasksFrom().get("task-1")?.record.status).toBe("running")
  })

  test("#given a run a reload paused #when the next generation's blocking wait runs #then that call restores the parked child, re-attaches it and completes the run", async () => {
    // given
    const directory = fresh()
    const { first, stop } = await startDriven(directory)
    const runId = first.dag.runtime.manager.list(RECOVERY_PARENT)[0]?.runId ?? ""
    await first.dispose(stop)
    const pausedGeneration = first.dag.record(runId).generation
    const second = generation(directory, first.dag.fakes)
    // The parked child is a stored row the new runtime does not own: its port refuses to capture it.
    const parked = first.dag.fakes[0]?.tasksFrom().get("task-1")
    expect(parked?.owned).toBe(false)

    // when
    const { fake, pending } = second.dag.begin({ action: "wait", run_id: runId, detach: false })
    fake.complete("a")
    await fake.whenStarted("b")
    fake.complete("b")
    const result = await pending

    // then
    expect(fake.restored).toEqual(["task-1"])
    expect(parked?.owned).toBe(true)
    expect(fake.starts.map((start) => start.nodeId)).toEqual(["b"])
    expect(result.details.kind === "waited" && result.details.result.status).toBe("completed")
    const record: Leased = second.dag.record(runId)
    expect(record.generation).toBe(pausedGeneration + 1)
    expect(record.leaseHolderPid).toBeUndefined()
    expect(first.dag.fakes.flatMap((earlier) => earlier.cancelled)).toEqual([])
  })

  test("#given a reload-paused run whose child had already settled before the reload #when the next generation's blocking wait runs #then Native recovery folds it without restoring it and the run completes", async () => {
    // given
    const directory = fresh()
    const first = generation(directory)
    const { result: started, fake: starter } = await first.dag.call({
      action: "start",
      detach: true,
      definition: { key: "settled", name: "settled", nodes: [node("a"), node("b", ["a"])] },
    })
    const runId = started.details.kind === "started" ? started.details.run_id : ""
    starter.complete("a")
    await first.dispose()
    expect(first.dag.record(runId).status).toBe("paused")
    const second = generation(directory, first.dag.fakes)

    // when
    const { fake, pending } = second.dag.begin({ action: "wait", run_id: runId, detach: false })
    await fake.whenStarted("b")
    fake.complete("b")
    const result = await pending

    // then
    expect(result.details.kind === "waited" && result.details.result.status).toBe("completed")
    expect(fake.restored).toEqual([])
    expect(fake.starts.map((start) => start.nodeId)).toEqual(["b"])
  })

  test("#given a run a reload paused #when the next generation's call cancels it #then that call restores the parked child, cancels it and the run is cancelled", async () => {
    // given
    const directory = fresh()
    const { first, stop, runId } = await startDriven(directory)
    await first.dispose(stop)
    const second = generation(directory, first.dag.fakes)

    // when
    const { fake, result } = await second.dag.call({ action: "cancel", run_id: runId, reason: "stop" })

    // then
    expect(result.details.kind).toBe("cancelled")
    expect(fake.restored).toEqual(["task-1"])
    expect(fake.cancelled).toEqual(["task-1"])
    expect(second.dag.record(runId).status).toBe("cancelled")
  })

  test("#given a run a reload paused #when the model calls resume #then that call recovers it detached, restores its child and starts nothing it cannot", async () => {
    // given
    const directory = fresh()
    const { first, stop, runId } = await startDriven(directory)
    await first.dispose(stop)
    const second = generation(directory, first.dag.fakes)

    // when
    const { fake, result } = await second.dag.call({ action: "resume", run_id: runId })

    // then
    expect(result.details.kind).toBe("detached")
    expect(result.content[0]?.text).toStartWith(`Resumed dag run ${runId}, which a plugin reload paused.`)
    expect(fake.restored).toEqual(["task-1"])
    expect(fake.starts).toEqual([])
    expect(second.dag.record(runId).status).toBe("running")
    expect(second.dag.runtime.driving()).toBe(0)
  })

  test("#given a paused run whose previous generation is still live #when another generation's call names it #then it is refused and nothing is restored", async () => {
    // given
    const directory = fresh()
    const { first, stop, runId } = await startDriven(directory)
    stop.abort(Error("closing"))
    for (const fake of first.dag.fakes) fake.park()
    await first.dag.runtime.pauseForShutdown()
    const second = generation(directory, first.dag.fakes)

    // when
    const { fake, result } = await second.dag.call({ action: "wait", run_id: runId })

    // then
    expect(result.details.kind === "error" && result.details.error.code).toBe("run_still_active")
    expect(fake.restored).toEqual([])
    expect(second.dag.record(runId).status).toBe("paused")
  })
})
