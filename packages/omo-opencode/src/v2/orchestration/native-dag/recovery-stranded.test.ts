import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test"
import {
  applyDagSchedulerEvent,
  createDagJournal,
  type DagRunId,
  type DagRunRecordV1,
} from "@oh-my-opencode/senpi-task/dag"
import { RECOVERY_PARENT, createRecoveryFixture, node, type Leased } from "./recovery-fixture"

/** The pid of a second OpenCode process on the same project (a generation lease owner). */
const OTHER_PROCESS = 4242

setDefaultTimeout(process.platform === "win32" ? 60_000 : 20_000)

const { generation, fresh, cleanup } = createRecoveryFixture()
afterEach(cleanup)

describe("OpenCode 2 workflow recovery of a stranded or foreign-held run", () => {
  test("#given a node whose admission was cut off with no task #when the next wait runs #then Native recovery starts it once inside that call and the run completes", async () => {
    // given
    const directory = fresh()
    const only = generation(directory)
    const started = await only.dag.runtime.manager.start({
      parentSessionId: RECOVERY_PARENT,
      rootSessionId: RECOVERY_PARENT,
      definition: { key: "cut", name: "cut", nodes: [node("a")] },
    })
    const runId = started.snapshot.runId
    const store = only.dag.runtime.store
    const journal = createDagJournal<DagRunRecordV1>({
      store,
      runId,
      initialCheckpoint: only.dag.record(runId),
      applyEvent: (record, event) =>
        applyDagSchedulerEvent(record, event, new Map(), { store, pendingTerminalResults: new Map(), now: Date.now }),
    })
    journal.append({
      type: "dag.node.transitioned",
      nodeId: "a",
      from: "pending",
      to: "scheduled",
      reason: { kind: "scheduled" },
    })
    await journal.whenIdle()

    // when
    const { fake, pending } = only.dag.begin({ action: "wait", run_id: runId, detach: false })
    await fake.whenStarted("a")
    fake.complete("a")
    const result = await pending

    // then
    expect(fake.starts.map((start) => start.nodeId)).toEqual(["a"])
    expect(result.details.kind === "waited" && result.details.result.status).toBe("completed")
  })

  test("#given a running run another OpenCode process holds #when this generation's call claims and releases it #then the claim fences the run meanwhile and the release writes that holder back instead of clearing it", async () => {
    // given
    const directory = fresh()
    const only = generation(directory)
    const { result: started } = await only.dag.call({
      action: "start",
      detach: true,
      definition: { key: "foreign", name: "foreign", nodes: [node("a")] },
    })
    const runId = (started.details.kind === "started" ? started.details.run_id : "") as DagRunId
    const store = only.dag.runtime.store,
      foreign = 2 ** 41 + 7
    store.withRunLock(runId, () => {
      store.writeCheckpoint(runId, { ...only.dag.record(runId), leaseHolderPid: foreign })
    })

    // when
    const { fake, pending } = only.dag.begin({ action: "wait", run_id: runId, detach: false })
    const holderDuring = async (): Promise<number | undefined> => {
      for (let turn = 0; turn < 200 && !only.dag.runtime.isDriving(runId); turn++)
        await new Promise((resolve) => setTimeout(resolve, 0))
      const during: Leased = only.dag.record(runId)
      return during.leaseHolderPid
    }
    const during = await holderDuring()
    fake.complete("a")
    const result = await pending

    // then
    expect(during).toBe(only.lease.holder())
    expect(result.details.kind === "waited" && result.details.result.status).toBe("completed")
    const after: Leased = only.dag.record(runId)
    expect(after.leaseHolderPid).toBe(foreign)
  })

  test("#given a running run a hard kill stranded after one child settled while another still runs #when the next generation's blocking wait runs #then Native recovery folds the settled child without attaching it unowned, restores the other and the run completes", async () => {
    // given
    const directory = fresh()
    const first = generation(directory)
    const { result: started, fake: starter } = await first.dag.call({
      action: "start",
      detach: true,
      definition: { key: "killed", name: "killed", nodes: [node("a"), node("b"), node("c", ["a", "b"])] },
    })
    const runId = started.details.kind === "started" ? started.details.run_id : ""
    starter.complete("a")
    await first.kill()
    expect(first.dag.record(runId).status).toBe("running")
    const second = generation(directory, first.dag.fakes)

    // when
    const { fake, pending } = second.dag.begin({ action: "wait", run_id: runId, detach: false })
    const outcome = pending.then(
      (result) => result,
      (error: unknown) => error,
    )
    for (let turn = 0; turn < 200 && fake.restored.length === 0; turn++)
      await new Promise((resolve) => setTimeout(resolve, 0))
    fake.complete("b")
    const early = await Promise.race([fake.whenStarted("c"), outcome])
    if (early instanceof Error) throw early
    fake.complete("c")
    const result = await outcome
    if (result instanceof Error) throw result

    // then
    expect(result.details.kind === "waited" && result.details.result.status).toBe("completed")
    expect(fake.restored).toEqual(["task-2"])
    expect(fake.starts.map((start) => start.nodeId)).toEqual(["c"])
  })
  test("#given a run a live OpenCode process is still driving #when a second process's call waits on it #then it refuses with run_still_active before pausing, recovering or restoring anything", async () => {
    // given
    const directory = fresh()
    const first = generation(directory, [], { pid: OTHER_PROCESS })
    const { fake: starter, pending: driving } = first.dag.begin({
      action: "start",
      definition: { key: "two", name: "two", nodes: [node("a")] },
    })
    await starter.whenStarted("a")
    const runId = first.dag.runtime.manager.list(RECOVERY_PARENT)[0]?.runId ?? ""
    // Both generations share this test process: retire the first one's in-process entry, so only its
    // pid (alive for the second process) can prove its holder live, as across two real processes.
    first.lease.dispose()
    const second = generation(directory, first.dag.fakes, { isProcessAlive: (pid) => pid === OTHER_PROCESS })

    // when
    const { fake, result } = await second.dag.call({ action: "wait", run_id: runId, detach: false })

    // then
    expect(result.details.kind === "error" && result.details.error.code).toBe("run_still_active")
    expect(fake.restored).toEqual([])
    const during: Leased = second.dag.record(runId)
    expect(during.status).toBe("running")
    expect(during.leaseHolderPid).toBe(first.lease.holder())
    const store = second.dag.runtime.store
    expect(store.readEvents(runId as DagRunId, 0, { limit: 1000 }).events.map((event) => event.type)).not.toContain(
      "dag.run.paused",
    )
    starter.complete("a")
    await driving
    expect(second.dag.record(runId).status).toBe("completed")
  })

  test("#given a run another holder settled while this generation's call still drives it #when this call's scheduler folds its child #then it does not write over the terminal state", async () => {
    // given
    const directory = fresh()
    const only = generation(directory)
    const { fake, pending } = only.dag.begin({
      action: "start",
      definition: { key: "fenced", name: "fenced", nodes: [node("a")] },
    })
    await fake.whenStarted("a")
    const runId = only.dag.runtime.manager.list(RECOVERY_PARENT)[0]?.runId as DagRunId
    const store = only.dag.runtime.store
    store.withRunLock(runId, () => {
      const { leaseHolderPid: _released, ...settled }: Leased = only.dag.record(runId)
      store.writeCheckpoint(runId, { ...settled, status: "failed" })
    })

    // when
    fake.complete("a")
    const outcome = await pending.then(
      (result) => result.details.kind,
      (error: unknown) => String(error),
    )

    // then
    expect(outcome).toBe("error")
    const after = only.dag.record(runId)
    expect(after.status).toBe("failed")
    expect(after.nodes.find((entry) => entry.id === "a")?.state).not.toBe("completed")
  })
})
