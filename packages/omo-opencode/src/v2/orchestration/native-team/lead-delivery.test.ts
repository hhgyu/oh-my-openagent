import { afterEach, describe, expect, test } from "bun:test"
import { createHash } from "node:crypto"
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { TeamModeConfigSchema, type TeamModeConfig } from "@oh-my-opencode/team-core/config"
import { listUnreadMessages, reserveMessageForDelivery, sendMessage } from "@oh-my-opencode/team-core/team-mailbox"
import { getInboxDir } from "@oh-my-opencode/team-core/team-registry"
import { RuntimeStateSchema, type Message } from "@oh-my-opencode/team-core/types"
import { saveRuntimeState, type loadRuntimeState } from "@oh-my-opencode/team-core/team-state-store"
import { openTeamDeliveryJournal } from "../../host/team-delivery-journal"
import {
  createLeadDeliveryOwner,
  teamDeliveryInputId,
  type LeadDeliveryOptions,
  type LeadDeliveryOwner,
  type TeamDeliverySession,
} from "./lead-delivery"

const RUN = "11111111-1111-4111-8111-111111111111",
  LEAD = "ses_lead",
  ALPHA = "ses_alpha",
  DIRECTORY = "/unit/project"
const roots: string[] = [],
  owners: LeadDeliveryOwner[] = []
afterEach(async () => {
  for (const owner of owners.splice(0)) await owner.close()
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

type Synthetic = Parameters<TeamDeliverySession["synthetic"]>[0]
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "omo-lead-delivery-"))
  roots.push(root)
  const config: TeamModeConfig = TeamModeConfigSchema.parse({ base_dir: join(root, "teams") })
  const state = RuntimeStateSchema.parse({
    version: 1,
    teamRunId: RUN,
    teamName: "qa-team",
    specSource: "project",
    createdAt: 1,
    status: "active",
    leadSessionId: LEAD,
    members: [{ name: "alpha", agentType: "general-purpose", status: "running" }],
    bounds: {},
  })
  const calls: Synthetic[] = [],
    accepted = new Map<string, Synthetic>(),
    gone = new Set<string>()
  // A host double with the 2.2.6 probe semantics: one row per id, a re-post returns the same row.
  const session: TeamDeliverySession = {
    async get({ sessionID }) {
      if (gone.has(sessionID)) throw Error("session not found")
      return { id: sessionID, location: { directory: DIRECTORY } }
    },
    async synthetic(input) {
      calls.push(input)
      const row = accepted.get(input.id) ?? input
      accepted.set(input.id, row)
      return { id: row.id, sessionID: row.sessionID, type: "synthetic", payload: { text: row.text } }
    },
  }
  return {
    root,
    config,
    state,
    calls,
    accepted,
    gone,
    session,
    journalPath: join(root, "lead-state", "team-deliveries.sqlite"),
  }
}
type Fixture = Awaited<ReturnType<typeof fixture>>
async function save(f: Fixture): Promise<void> {
  mkdirSync(join(f.config.base_dir ?? "", "runtime", RUN), { recursive: true })
  await saveRuntimeState(f.state, f.config)
}
function owner(f: Fixture, overrides: Partial<LeadDeliveryOptions> = {}): LeadDeliveryOwner {
  const value = createLeadDeliveryOwner({
    session: f.session,
    directory: DIRECTORY,
    assertGeneration() {},
    teamConfigFor: () => f.config,
    journalPathFor: () => f.journalPath,
    isMemberBound: (sessionID) => sessionID === ALPHA,
    pollIntervalMs: 0,
    ...overrides,
  })
  owners.push(value)
  return value
}
function message(messageId: string, from: string, to: string): Message {
  return { version: 1, messageId, from, to, kind: "message", body: `body ${messageId}`, timestamp: 1 }
}
async function seedToLead(f: Fixture, messageId: string): Promise<Message> {
  const value = message(messageId, "alpha", "lead")
  await sendMessage(value, RUN, f.config, { isLead: false, activeMembers: ["alpha"], leadRecipient: "lead" })
  return value
}
async function seedToAlpha(f: Fixture, messageId: string): Promise<Message> {
  const value = message(messageId, "lead", "alpha")
  await sendMessage(value, RUN, f.config, { isLead: true, activeMembers: ["alpha"] })
  return value
}
const inbox = (f: Fixture, recipient: string) => getInboxDir(f.config.base_dir ?? "", RUN, recipient)
const processed = (f: Fixture, recipient: string, value: Message) =>
  existsSync(join(inbox(f, recipient), "processed", `${value.messageId}.json`))
const reservations = (f: Fixture, recipient: string) =>
  readdirSync(inbox(f, recipient)).filter((name) => name.startsWith(".delivering-"))
function bindAlpha(value: LeadDeliveryOwner) {
  return value.memberBound({ leadSessionID: LEAD, teamRunId: RUN, memberName: "alpha", sessionID: ALPHA })
}

describe("lead delivery owner", () => {
  test("#given one member send #when the team is polled twice #then the lead gets one synthetic with the deterministic id", async () => {
    // given
    const f = fixture()
    await save(f)
    const sent = await seedToLead(f, "22222222-2222-4222-8222-000000000001")
    const delivery = owner(f)
    bindAlpha(delivery)

    // when
    await delivery.refresh(RUN)
    await delivery.refresh(RUN)

    // then
    expect(f.calls).toHaveLength(1)
    expect(f.calls[0]).toMatchObject({
      sessionID: LEAD,
      id: teamDeliveryInputId(RUN, "lead", sent.messageId),
      delivery: "steer",
      resume: true,
    })
    expect(f.calls[0]?.text).toContain(`messageId="${sent.messageId}"`)
    expect(processed(f, "lead", sent)).toBe(true)
    expect(reservations(f, "lead")).toEqual([])
  })

  test("#given a lead send to a bound member #when the team is polled twice #then the member gets one synthetic", async () => {
    // given
    const f = fixture()
    await save(f)
    const sent = await seedToAlpha(f, "22222222-2222-4222-8222-000000000002")
    const delivery = owner(f)
    bindAlpha(delivery)

    // when
    await delivery.refresh(RUN)
    await delivery.refresh(RUN)

    // then
    expect(f.calls.map((call) => [call.sessionID, call.id])).toEqual([
      [ALPHA, teamDeliveryInputId(RUN, "alpha", sent.messageId)],
    ])
    expect(processed(f, "alpha", sent)).toBe(true)
  })

  test("#given the host accepted but the ACK was lost in a crash #when a fresh owner runs #then it reposts the same id and the host keeps one row", async () => {
    // given
    const f = fixture()
    await save(f)
    const sent = await seedToLead(f, "22222222-2222-4222-8222-000000000003")
    const lossy: TeamDeliverySession = {
      ...f.session,
      async synthetic(input) {
        await f.session.synthetic(input)
        throw Error("crash before the ACK was recorded")
      },
    }
    const first = owner(f, { session: lossy })
    bindAlpha(first)
    await first.refresh(RUN)
    await first.close()
    expect(await reserveMessageForDelivery(RUN, "lead", sent.messageId, f.config)).not.toBeNull()

    // when
    const restarted = owner(f)
    bindAlpha(restarted)
    await restarted.refresh(RUN)
    await restarted.refresh(RUN)

    // then
    const inputID = teamDeliveryInputId(RUN, "lead", sent.messageId)
    expect(f.calls.length).toBeGreaterThan(1)
    expect(new Set(f.calls.map((call) => call.id))).toEqual(new Set([inputID]))
    expect(f.accepted.size).toBe(1)
    expect(processed(f, "lead", sent)).toBe(true)
    expect(await listUnreadMessages(RUN, "lead", f.config)).toEqual([])
  })

  test("#given a journal intent without an ACK and a stale reservation #when the owner restarts #then the same id is posted once and committed", async () => {
    // given
    const f = fixture()
    await save(f)
    const sent = await seedToLead(f, "22222222-2222-4222-8222-000000000004")
    const first = owner(f, {
      session: {
        ...f.session,
        async synthetic() {
          throw Error("host crashed before ACK")
        },
      },
    })
    bindAlpha(first)
    await first.refresh(RUN)
    await first.close()
    expect(await reserveMessageForDelivery(RUN, "lead", sent.messageId, f.config)).not.toBeNull()

    // when
    const restarted = owner(f)
    bindAlpha(restarted)
    await restarted.refresh(RUN)
    await restarted.refresh(RUN)

    // then
    expect(f.calls.map((call) => call.id)).toEqual([teamDeliveryInputId(RUN, "lead", sent.messageId)])
    expect(processed(f, "lead", sent)).toBe(true)
    expect(await listUnreadMessages(RUN, "lead", f.config)).toEqual([])
    expect(reservations(f, "lead")).toEqual([])
  })
})

describe("lead delivery owner authority", () => {
  type LoadState = typeof loadRuntimeState
  async function expectHeld(f: Fixture, delivery: LeadDeliveryOwner, recipient: string, sent: Message) {
    bindAlpha(delivery)
    await delivery.refresh(RUN)
    expect(f.calls).toEqual([])
    expect(reservations(f, recipient)).toEqual([])
    expect((await listUnreadMessages(RUN, recipient, f.config)).map((value) => value.messageId)).toEqual([
      sent.messageId,
    ])
  }

  test("#given the lead session is gone #when mail is due #then no synthetic is posted and the reservation is released", async () => {
    // given
    const f = fixture()
    await save(f)
    const sent = await seedToLead(f, "22222222-2222-4222-8222-000000000005")
    f.gone.add(LEAD)

    // when / then
    await expectHeld(f, owner(f), "lead", sent)
  })

  test("#given the component generation retires during the pass #when mail is due #then no synthetic is posted and the reservation is released", async () => {
    // given
    const f = fixture()
    await save(f)
    const sent = await seedToLead(f, "22222222-2222-4222-8222-000000000006")
    let checks = 0

    // when / then
    await expectHeld(
      f,
      owner(f, {
        assertGeneration() {
          if (++checks > 1) throw Error("Retired Native task generation")
        },
      }),
      "lead",
      sent,
    )
  })

  test("#given the team stops being active during the pass #when mail is due #then no synthetic is posted and the reservation is released", async () => {
    // given
    const f = fixture()
    await save(f)
    const sent = await seedToLead(f, "22222222-2222-4222-8222-000000000007")
    let reads = 0
    const loadState: LoadState = async () => ({ ...f.state, status: ++reads > 1 ? "deleting" : "active" })

    // when / then
    await expectHeld(f, owner(f, { loadState }), "lead", sent)
  })

  test("#given the member producer unbinds during the pass #when lead mail is due #then no synthetic is posted and the reservation is released", async () => {
    // given
    const f = fixture()
    await save(f)
    const sent = await seedToAlpha(f, "22222222-2222-4222-8222-000000000008")
    let checks = 0

    // when / then
    await expectHeld(f, owner(f, { isMemberBound: () => ++checks === 1 }), "alpha", sent)
  })

  test("#given a team that is not active #when it is polled #then nothing is reserved or posted and its pollers stop", async () => {
    // given
    const f = fixture()
    await save(f)
    const sent = await seedToLead(f, "22222222-2222-4222-8222-000000000009")
    await saveRuntimeState({ ...f.state, status: "deleted" }, f.config)

    // when / then
    await expectHeld(f, owner(f), "lead", sent)
  })
})

describe("lead delivery owner journal cleanup", () => {
  const namespace =
    "opencode2-team:" +
    createHash("sha256")
      .update(JSON.stringify([DIRECTORY, LEAD]))
      .digest("hex")
  function rows(f: Fixture, recipient: string, messageId: string) {
    const journal = openTeamDeliveryJournal({ path: f.journalPath, namespace })
    try {
      return journal.read({ teamRunId: RUN, recipient, messageId })
    } finally {
      journal.close()
    }
  }

  test("#given a delete whose tick saw deleting #when the final refresh finds no team #then no rows of that run remain", async () => {
    // given
    const f = fixture()
    await save(f)
    const sent = await seedToLead(f, "22222222-2222-4222-8222-000000000010")
    const delivery = owner(f)
    bindAlpha(delivery)
    await delivery.refresh(RUN)
    await saveRuntimeState({ ...f.state, status: "deleting" }, f.config)
    await delivery.refresh(RUN)

    // when
    rmSync(join(f.config.base_dir ?? "", "runtime", RUN), { recursive: true, force: true })
    await delivery.refresh(RUN)
    await delivery.close()

    // then
    expect(f.calls).toHaveLength(1)
    expect(rows(f, "lead", sent.messageId)).toBeUndefined()
  })

  test("#given a run that is still deleting #when it is refreshed #then its rows are kept", async () => {
    // given
    const f = fixture()
    await save(f)
    const sent = await seedToLead(f, "22222222-2222-4222-8222-000000000011")
    const delivery = owner(f)
    bindAlpha(delivery)
    await delivery.refresh(RUN)

    // when
    await saveRuntimeState({ ...f.state, status: "deleting" }, f.config)
    await delivery.refresh(RUN)
    await delivery.refresh(RUN)
    await delivery.close()

    // then
    expect(rows(f, "lead", sent.messageId)?.phase).toBe("acked")
  })

  test("#given an unacked intent of a deleted run #when the owner sees the run #then the intent is dropped and never posted", async () => {
    // given
    const f = fixture()
    await save(f)
    const sent = await seedToLead(f, "22222222-2222-4222-8222-000000000012")
    expect(await reserveMessageForDelivery(RUN, "lead", sent.messageId, f.config)).not.toBeNull()
    const journal = openTeamDeliveryJournal({ path: f.journalPath, namespace })
    journal.recordIntent(
      { teamRunId: RUN, recipient: "lead", messageId: sent.messageId },
      LEAD,
      teamDeliveryInputId(RUN, "lead", sent.messageId),
    )
    journal.close()
    await saveRuntimeState({ ...f.state, status: "deleted" }, f.config)
    const delivery = owner(f)

    // when
    bindAlpha(delivery)
    await delivery.refresh(RUN)
    await delivery.refresh(RUN)
    await delivery.close()

    // then
    expect(f.calls).toEqual([])
    expect(rows(f, "lead", sent.messageId)).toBeUndefined()
  })
})

describe("lead delivery owner reload recovery", () => {
  const namespace =
    "opencode2-team:" +
    createHash("sha256")
      .update(JSON.stringify([DIRECTORY, LEAD]))
      .digest("hex")
  const ALPHA_RESTORED = "ses_alpha_restored"
  function row(f: Fixture, recipient: string, messageId: string) {
    const journal = openTeamDeliveryJournal({ path: f.journalPath, namespace })
    try {
      return journal.read({ teamRunId: RUN, recipient, messageId })
    } finally {
      journal.close()
    }
  }
  function strand(f: Fixture, recipient: string, receiver: string, messageId: string) {
    const journal = openTeamDeliveryJournal({ path: f.journalPath, namespace })
    try {
      journal.recordIntent(
        { teamRunId: RUN, recipient, messageId },
        receiver,
        teamDeliveryInputId(RUN, recipient, messageId),
      )
    } finally {
      journal.close()
    }
  }

  test("#given a stranded un-ACKed lead intent and no member bound #when a fresh owner resumes the lead #then the same id is posted once and committed", async () => {
    // given
    const f = fixture()
    await save(f)
    const sent = await seedToLead(f, "22222222-2222-4222-8222-000000000013")
    expect(await reserveMessageForDelivery(RUN, "lead", sent.messageId, f.config)).not.toBeNull()
    strand(f, "lead", LEAD, sent.messageId)
    const delivery = owner(f)

    // when
    await delivery.resumeLead(LEAD)
    await delivery.resumeLead(LEAD)
    await delivery.refresh(RUN)

    // then
    expect(f.calls.map((call) => [call.sessionID, call.id])).toEqual([
      [LEAD, teamDeliveryInputId(RUN, "lead", sent.messageId)],
    ])
    expect(processed(f, "lead", sent)).toBe(true)
    expect(reservations(f, "lead")).toEqual([])
    expect(row(f, "lead", sent.messageId)?.phase).toBe("acked")
  })

  test("#given the lead session is gone #when the lead resumes #then nothing is posted and the mail stays unread", async () => {
    // given
    const f = fixture()
    await save(f)
    const sent = await seedToLead(f, "22222222-2222-4222-8222-000000000014")
    f.gone.add(LEAD)
    const delivery = owner(f)

    // when
    await delivery.resumeLead(LEAD)

    // then
    expect(f.calls).toEqual([])
    expect((await listUnreadMessages(RUN, "lead", f.config)).map((value) => value.messageId)).toEqual([sent.messageId])
  })

  test("#given an un-ACKed intent held for a member's old session #when the member binds with its restored session #then the intent moves there and is delivered once with the same id", async () => {
    // given
    const f = fixture()
    await save(f)
    const sent = await seedToAlpha(f, "22222222-2222-4222-8222-000000000015")
    const first = owner(f, {
      session: {
        ...f.session,
        async synthetic() {
          throw Error("host crashed before ACK")
        },
      },
    })
    bindAlpha(first)
    await first.refresh(RUN)
    await first.close()
    expect(row(f, "alpha", sent.messageId)).toMatchObject({ phase: "intent", receiverSessionID: ALPHA })
    const restarted = owner(f, { isMemberBound: (sessionID) => sessionID === ALPHA_RESTORED })

    // when
    restarted.memberBound({ leadSessionID: LEAD, teamRunId: RUN, memberName: "alpha", sessionID: ALPHA_RESTORED })
    await restarted.refresh(RUN)
    await restarted.refresh(RUN)

    // then
    expect(f.calls.map((call) => [call.sessionID, call.id])).toEqual([
      [ALPHA_RESTORED, teamDeliveryInputId(RUN, "alpha", sent.messageId)],
    ])
    expect(processed(f, "alpha", sent)).toBe(true)
    expect(row(f, "alpha", sent.messageId)).toMatchObject({
      phase: "acked",
      receiverSessionID: ALPHA_RESTORED,
      previousReceivers: [ALPHA],
    })
  })

  test("#given a moved intent the host had already accepted in the old session #when it is re-posted #then the earlier row is accepted as its ACK", async () => {
    // given
    const f = fixture()
    await save(f)
    const sent = await seedToAlpha(f, "22222222-2222-4222-8222-000000000016")
    const lossy: TeamDeliverySession = {
      ...f.session,
      async synthetic(input) {
        await f.session.synthetic(input)
        throw Error("crash before the ACK was recorded")
      },
    }
    const first = owner(f, { session: lossy })
    bindAlpha(first)
    await first.refresh(RUN)
    await first.close()
    const restarted = owner(f, { isMemberBound: (sessionID) => sessionID === ALPHA_RESTORED })

    // when
    restarted.memberBound({ leadSessionID: LEAD, teamRunId: RUN, memberName: "alpha", sessionID: ALPHA_RESTORED })
    await restarted.refresh(RUN)
    await restarted.refresh(RUN)

    // then
    expect(f.accepted.size).toBe(1)
    expect(processed(f, "alpha", sent)).toBe(true)
    expect(row(f, "alpha", sent.messageId)).toMatchObject({ phase: "acked", ack: { sessionID: ALPHA } })
  })

  test("#given an un-ACKed intent of a member that left the team #when the lead resumes #then the intent is dropped and never posted", async () => {
    // given
    const f = fixture()
    await save(f)
    strand(f, "gamma", "ses_gamma", "22222222-2222-4222-8222-000000000017")
    const delivery = owner(f)

    // when
    await delivery.resumeLead(LEAD)

    // then
    expect(f.calls).toEqual([])
    expect(row(f, "gamma", "22222222-2222-4222-8222-000000000017")).toBeUndefined()
  })
})
