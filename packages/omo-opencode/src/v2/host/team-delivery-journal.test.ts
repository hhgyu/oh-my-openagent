import { afterEach, describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { openTeamDeliveryJournal, type TeamDeliveryJournal } from "./team-delivery-journal"

const dirs: string[] = [], journals: TeamDeliveryJournal[] = []
afterEach(() => { for (const journal of journals.splice(0)) journal.close(); for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }) })
function file() { const dir = mkdtempSync(join(tmpdir(), "omo-team-delivery-")); dirs.push(dir); return join(dir, "team-deliveries.sqlite") }
function open(path = file(), namespace = "/unit/project:lead") { const journal = openTeamDeliveryJournal({ path, namespace }); journals.push(journal); return journal }
const key = { teamRunId: "run-1", recipient: "lead", messageId: "m-1" }

describe("team delivery journal", () => {
  test("#given an intent #when it is recorded again after a reopen #then the same input id is returned and the ACK is durable", () => {
    // given
    const path = file()
    const first = open(path)
    const intent = first.recordIntent(key, "ses_lead", "msg_omo_team_a")
    first.close()

    // when
    const second = open(path)
    const again = second.recordIntent(key, "ses_lead", "msg_omo_team_a")
    const acked = second.markAcked(again, { id: "msg_omo_team_a", sessionID: "ses_lead" })

    // then
    expect(again).toEqual(intent)
    expect(acked.phase).toBe("acked")
    expect(second.isAcked(key)).toBe(true)
    expect(second.markAcked(again, { id: "msg_omo_team_a", sessionID: "ses_lead" })).toEqual(acked)
  })

  test("#given an intent #when another receiver, input id or foreign ACK is offered #then it is refused", () => {
    // given
    const journal = open()
    const intent = journal.recordIntent(key, "ses_lead", "msg_omo_team_a")

    // when / then
    expect(() => journal.recordIntent(key, "ses_other", "msg_omo_team_a")).toThrow("another receiver")
    expect(() => journal.recordIntent(key, "ses_lead", "msg_omo_team_b")).toThrow("another receiver")
    expect(() => journal.markAcked(intent, { id: "msg_other", sessionID: "ses_lead" })).toThrow("ACK differs")
    expect(() => journal.recordIntent({ ...key, messageId: "m-2" }, "ses_lead", "not-a-host-id")).toThrow("Invalid team delivery record")
    expect(journal.isAcked(key)).toBe(false)
  })

  test("#given a journal of another namespace #when it is opened #then it is refused; a dropped team forgets its rows", () => {
    // given
    const path = file()
    const journal = open(path)
    journal.recordIntent(key, "ses_lead", "msg_omo_team_a")

    // when
    journal.dropTeam("run-1")

    // then
    expect(journal.read(key)).toBeUndefined()
    journal.close()
    expect(() => open(path, "/unit/other")).toThrow("Foreign team delivery journal namespace")
  })
})
