import { afterEach, describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { openDagDeliveryJournal, type DagDeliveryJournal } from "./dag-delivery-journal"

const dirs: string[] = [],
  journals: DagDeliveryJournal[] = []
afterEach(() => {
  for (const journal of journals.splice(0)) journal.close()
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})
function file() {
  const dir = mkdtempSync(join(tmpdir(), "omo-dag-delivery-"))
  dirs.push(dir)
  return join(dir, "dag-wakes.sqlite")
}
function open(path = file(), namespace = "/unit/project:root") {
  const journal = openDagDeliveryJournal({ path, namespace })
  journals.push(journal)
  return journal
}
const key = { runId: "dag_1", seq: 7 }
const wake = { kind: "frontier" as const, receiverSessionID: "ses_root", inputID: "msg_omo_dag_a", text: "wake a" }

describe("DAG delivery journal", () => {
  test("#given an intent #when another wake for the same checkpoint is recorded after a reopen #then the first row is kept and its ACK is durable", () => {
    // given
    const path = file()
    const first = open(path)
    const intent = first.recordIntent(key, wake)
    first.close()

    // when
    const second = open(path)
    const again = second.recordIntent(key, { ...wake, kind: "finished", inputID: "msg_omo_dag_b", text: "wake b" })
    const acked = second.markAcked(again, { id: "msg_omo_dag_a", sessionID: "ses_root" })

    // then
    expect(again).toEqual(intent)
    expect(acked.phase).toBe("acked")
    expect(second.read(key)?.phase).toBe("acked")
  })

  test("#given an intent #when a foreign ACK, another root or a non-DAG id is offered #then it is refused", () => {
    // given
    const journal = open()
    const intent = journal.recordIntent(key, wake)

    // when / then
    expect(() => journal.markAcked(intent, { id: "msg_other", sessionID: "ses_root" })).toThrow("ACK differs")
    expect(() => journal.recordIntent(key, { ...wake, receiverSessionID: "ses_other" })).toThrow("another root")
    expect(() => journal.recordIntent({ runId: "dag_2", seq: 1 }, { ...wake, inputID: "msg_omo_team_a" })).toThrow(
      "Invalid DAG delivery record",
    )
  })

  test("#given rows of two runs #when one run is dropped #then only its rows are gone", () => {
    // given
    const journal = open()
    journal.recordIntent(key, wake)
    journal.recordIntent({ runId: "dag_2", seq: 1 }, wake)

    // when
    journal.dropRun("dag_1")

    // then
    expect(journal.listRuns()).toEqual(["dag_2"])
  })

  test("#given the same wake id journaled at two checkpoints #when it is looked up by id #then the acked row is found, and another run or id finds nothing", () => {
    // given
    const journal = open()
    journal.recordIntent(key, wake)
    const later = journal.recordIntent({ runId: "dag_1", seq: 9 }, wake)
    journal.markAcked(later, { id: wake.inputID, sessionID: "ses_root" })

    // when
    const found = journal.findInput("dag_1", wake.inputID)

    // then
    expect(found?.seq).toBe(9)
    expect(found?.phase).toBe("acked")
    expect(journal.findInput("dag_2", wake.inputID)).toBeUndefined()
    expect(journal.findInput("dag_1", "msg_omo_dag_other")).toBeUndefined()
  })

  test("#given a journal of another namespace #when it is opened #then it is refused", () => {
    // given
    const path = file()
    open(path).close()

    // when / then
    expect(() => open(path, "/unit/project:other")).toThrow("Foreign DAG delivery journal namespace")
  })
})
