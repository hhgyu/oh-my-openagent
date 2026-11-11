import { afterEach, describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { openChildJournal } from "../host/child-journal"
import type { SessionBackendApi } from "../host/session-backend"
import { withJoinedSessionCancellation } from "../host/session-cancellation"
import { createSessionScopes, type SessionLease } from "../host/session-state"
import { FACTS_AGENT_ID, FACTS_PERMISSIONS } from "./facts-agent"
import { FACTS_BACKEND_ID, reclaimStrandedFactsChildren } from "./facts-child-reclaim"
import { FACTS_RECORD_TOOL_NAME } from "./facts-record-tool"
import { createMemoryChildPort, type MemoryChildPort } from "./memory-child-port"

const roots: string[] = []
const ports: MemoryChildPort[] = []
afterEach(async () => {
  // The dead owner's port is closed last; its cleanup fails once custody moved, which is the point.
  await Promise.allSettled(ports.splice(0).map(port => port.close()))
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

type Ref = { id: SessionLease["sessionID"]; parentID?: SessionLease["sessionID"]; location: { directory: string } }
const APP = { name: "opencode", version: "2.2.6", channel: "stable" } as never

function host() {
  const root = mkdtempSync(join(tmpdir(), "omo-v2-facts-reclaim-"))
  roots.push(root)
  const directory = join(root, "project")
  const factsDir = join(root, "facts")
  mkdirSync(factsDir, { recursive: true })
  const events: string[] = []
  const failures = { remove: false }
  const sessions = new Map<string, Ref>([["root", { id: "root" as Ref["id"], location: { directory } }]])
  const api: SessionBackendApi = {
    async create(input) {
      const value: Ref = { id: input.id as Ref["id"], parentID: input.parentID as Ref["id"], location: { directory } }
      sessions.set(value.id, value)
      return value
    },
    async get({ sessionID }) { const value = sessions.get(sessionID); if (value === undefined) throw new Error("not found"); return value },
    async list() { return { data: [...sessions.values()], cursor: {} } },
    async prompt(input) { return { id: String(input.id), sessionID: input.sessionID as Ref["id"] } },
    async synthetic(input) { return { id: String(input.id), sessionID: input.sessionID as Ref["id"] } },
    async interrupt({ sessionID }) { events.push(`interrupt:${sessionID}`); return { interrupted: true } },
    async wait({ sessionID }) { events.push(`wait:${sessionID}`) },
    async remove({ sessionID }) {
      events.push(`remove:${sessionID}`)
      if (failures.remove) throw new Error("host remove failed")
      sessions.delete(sessionID)
    },
    async context() { return [] as never },
    instructions: { entry: { async list() { return [] }, async put() {}, async remove() {} } },
  }
  // Controlled fake contract only: these methods accept the test-owned request signals.
  withJoinedSessionCancellation(api, "controlled-test")
  return { api, directory, journalPath: join(factsDir, "children.sqlite"), sessions, events, failures }
}

/** A facts child staged by an owner that then "dies": its port and journal are never closed. */
async function strandedChild(h: ReturnType<typeof host>, priorLeases = 0): Promise<string> {
  const scopes = createSessionScopes()
  // Earlier leases of the dead host's scope raise the generation its locator records.
  for (let index = 0; index < priorLeases; index += 1) scopes.open(`ses_prior_${index}` as SessionLease["sessionID"], { tools: [], authorize: () => undefined })
  const port = createMemoryChildPort({
    host: { app: APP, session: h.api }, directory: h.directory, parentSessionId: "root", journalPath: h.journalPath,
    backendID: FACTS_BACKEND_ID, prefix: "facts", label: "Facts", agent: FACTS_AGENT_ID, permissions: FACTS_PERMISSIONS.map(rule => ({ ...rule })),
    toolNames: [FACTS_RECORD_TOOL_NAME], scopes, onIssued: () => undefined, onRetired: () => undefined,
  })
  ports.push(port)
  const child = await port.start({ generation: 1, prompt: "payload" })
  return child.sessionID
}

async function row(journalPath: string, sessionID: string) {
  const journal = await openChildJournal({ path: journalPath })
  try {
    return (await journal.list()).find(record => record.locator.sessionID === sessionID)
  } finally {
    journal.close()
  }
}

async function rowPhase(journalPath: string, sessionID: string): Promise<string | undefined> {
  const journal = await openChildJournal({ path: journalPath })
  try {
    return (await journal.list()).find(record => record.locator.sessionID === sessionID)?.phase
  } finally {
    journal.close()
  }
}

describe("stranded facts child reclaim", () => {
  test("#given a dead owner's custody row with a live host child #when reclaim runs #then the host child is interrupted, joined and removed and the row is CLOSED", async () => {
    // given
    const h = host()
    const sessionID = await strandedChild(h)
    // when
    const report = await reclaimStrandedFactsChildren({ host: { app: APP, session: h.api }, journalPath: h.journalPath, warn: () => undefined, probeOwner: async () => "dead" })
    // then
    expect(report).toEqual({ removed: [sessionID], closed: [], left: [], skipped: [] })
    expect(h.events).toEqual([`interrupt:${sessionID}`, `wait:${sessionID}`, `remove:${sessionID}`])
    expect(h.sessions.has(sessionID)).toBe(false)
    expect(await rowPhase(h.journalPath, sessionID)).toBe("closed")
  })

  test("#given a live owner's custody row #when reclaim runs #then the row and its host child are left alone", async () => {
    // given
    const h = host()
    const sessionID = await strandedChild(h)
    const before = await rowPhase(h.journalPath, sessionID)
    // when
    const report = await reclaimStrandedFactsChildren({ host: { app: APP, session: h.api }, journalPath: h.journalPath, warn: () => undefined, probeOwner: async () => "alive" })
    // then
    expect(report).toEqual({ removed: [], closed: [], left: [sessionID], skipped: [] })
    expect(h.events).toEqual([])
    expect(h.sessions.has(sessionID)).toBe(true)
    expect(await rowPhase(h.journalPath, sessionID)).toBe(before)
  })

  test("#given a dead owner's row whose host child is already gone #when reclaim runs #then the row is closed without error and no host call is made", async () => {
    // given
    const h = host()
    const sessionID = await strandedChild(h)
    h.sessions.delete(sessionID)
    // when
    const report = await reclaimStrandedFactsChildren({ host: { app: APP, session: h.api }, journalPath: h.journalPath, warn: () => undefined, probeOwner: async () => "dead" })
    // then
    expect(report).toEqual({ removed: [], closed: [sessionID], left: [], skipped: [] })
    expect(h.events).toEqual([])
    expect(await rowPhase(h.journalPath, sessionID)).toBe("closed")
  })

  test("#given a dead owner's row recorded at a generation above a fresh scope's #when reclaim runs #then the generation only rises, the host child is removed and the row is CLOSED", async () => {
    // given
    const h = host()
    const sessionID = await strandedChild(h, 4)
    const stranded = await row(h.journalPath, sessionID)
    // when
    const report = await reclaimStrandedFactsChildren({ host: { app: APP, session: h.api }, journalPath: h.journalPath, warn: () => undefined, probeOwner: async () => "dead" })
    // then
    expect(stranded?.locator.generation).toBe(5)
    expect(report).toEqual({ removed: [sessionID], closed: [], left: [], skipped: [] })
    expect(h.sessions.has(sessionID)).toBe(false)
    const closed = await row(h.journalPath, sessionID)
    expect(closed?.phase).toBe("closed")
    expect(closed?.locator.generation ?? 0).toBeGreaterThanOrEqual(5)
  })

  test("#given a reclaim that took custody and failed #when the next reconcile runs #then the same revision is skipped without repeating host calls", async () => {
    // given
    const h = host()
    const sessionID = await strandedChild(h)
    h.failures.remove = true
    const warnings: string[] = []
    const reclaim = () => reclaimStrandedFactsChildren({ host: { app: APP, session: h.api }, journalPath: h.journalPath, warn: message => { warnings.push(message) }, probeOwner: async () => "dead" })
    const first = await reclaim()
    const callsAfterFirst = h.events.length
    // when
    const second = await reclaim()
    // then
    expect(first).toEqual({ removed: [], closed: [], left: [sessionID], skipped: [] })
    expect(second).toEqual({ removed: [], closed: [], left: [], skipped: [sessionID] })
    expect(h.events).toHaveLength(callsAfterFirst)
    expect(warnings.filter(message => message.startsWith("stranded facts child could not be reclaimed"))).toHaveLength(1)
  })

  test("#given no custody journal yet #when reclaim runs #then it reports nothing and creates nothing", async () => {
    // given
    const h = host()
    // when
    const report = await reclaimStrandedFactsChildren({ host: { app: APP, session: h.api }, journalPath: h.journalPath, warn: () => undefined })
    // then
    expect(report).toEqual({ removed: [], closed: [], left: [], skipped: [] })
  })
})
