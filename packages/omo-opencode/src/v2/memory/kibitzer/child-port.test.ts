import { afterEach, describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { openChildJournal } from "../../host/child-journal"
import type { SessionBackendApi } from "../../host/session-backend"
import { withJoinedSessionCancellation } from "../../host/session-cancellation"
import { createSessionScopes, type SessionLease } from "../../host/session-state"
import { KIBITZER_AGENT_ID, KIBITZER_PERMISSIONS } from "./agent"
import { createKibitzerChildPort, turnReport } from "./child-port"

const roots: string[] = []
const ports: { close(): Promise<void> }[] = []
afterEach(async () => {
  // The SQLite journal must be released before its directory can be removed (Windows).
  await Promise.allSettled(ports.splice(0).map(port => port.close()))
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

type Ref = { id: SessionLease["sessionID"]; parentID?: SessionLease["sessionID"]; location: { directory: string } }

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "omo-v2-kibitzer-port-"))
  roots.push(root)
  const directory = join(root, "project")
  const journalPath = join(root, "recall", "sidecars", "cm9vdA", "children.sqlite")
  const events: string[] = []
  const creates: { agent?: unknown; permissions?: unknown; parentID?: unknown }[] = []
  const prompts: { id?: unknown; delivery?: unknown; resume?: unknown; text: string }[] = []
  const sessions = new Map<string, Ref>([["root", { id: "root" as Ref["id"], location: { directory } }]])
  let transcript: unknown[] = []
  const api: SessionBackendApi = {
    async create(input) {
      events.push("create")
      creates.push({ agent: input.agent, permissions: input.permissions, parentID: input.parentID })
      const value: Ref = { id: input.id as Ref["id"], parentID: input.parentID as Ref["id"], location: { directory } }
      sessions.set(value.id, value)
      return value
    },
    async get({ sessionID }) { const value = sessions.get(sessionID); if (value === undefined) throw new Error("not found"); return value },
    async list() { return { data: [...sessions.values()], cursor: {} } },
    async prompt(input) { events.push("prompt"); prompts.push({ id: input.id, delivery: input.delivery, resume: input.resume, text: input.text }); return { id: String(input.id), sessionID: input.sessionID as Ref["id"] } },
    async synthetic(input) { events.push("synthetic"); return { id: String(input.id), sessionID: input.sessionID as Ref["id"] } },
    async interrupt() { events.push("interrupt"); return { interrupted: true } },
    async wait() { events.push("wait") },
    async remove({ sessionID }) { events.push("remove"); sessions.delete(sessionID) },
    async context() { return transcript as never },
    instructions: { entry: { async list() { return [] }, async put() {}, async remove() {} } },
  }
  // Controlled fake contract only: these methods accept the test-owned request signals.
  withJoinedSessionCancellation(api, "controlled-test")
  const scopes = createSessionScopes()
  const issued: string[] = []
  const retired: string[] = []
  let next = 0
  const port = createKibitzerChildPort({
    host: { app: { name: "opencode", version: "2.2.6", channel: "stable" } as never, session: api },
    directory, parentSessionId: "root", journalPath, agent: KIBITZER_AGENT_ID, permissions: KIBITZER_PERMISSIONS.map(rule => ({ ...rule })),
    toolNames: ["read", "grep", "session_entries", "memory", "nudge"], scopes,
    onIssued: child => { issued.push(child.sessionID) }, onRetired: sessionID => { retired.push(sessionID) },
    newId: () => `id${++next}`,
  })
  ports.push(port)
  return { port, events, creates, prompts, sessions, issued, retired, journalPath, setTranscript: (value: unknown[]) => { transcript = value } }
}

describe("kibitzer child port over the owned session backend", () => {
  test("#given a seed #then the child is staged as the hidden kibitzer agent with deny-all-but-five permissions and its first input is admitted once", async () => {
    // given
    const f = fixture()
    // when
    const child = await f.port.start({ sessionId: "root", generation: 1, prompt: "<kibitzer-seed/>" })
    // then
    expect(f.events).toEqual(["create", "prompt"])
    expect(f.creates[0]).toMatchObject({ agent: "kibitzer", parentID: "root" })
    expect(f.creates[0]?.permissions).toEqual([
      { action: "*", resource: "*", effect: "deny" },
      ...["read", "grep", "session_entries", "memory", "nudge"].map(action => ({ action, resource: "*", effect: "allow" })),
    ])
    expect(f.prompts).toEqual([{ id: "msg_kibitzer_id2", delivery: undefined, resume: true, text: "<kibitzer-seed/>" }])
    expect(f.issued).toEqual([child.sessionID])
    await f.port.close()
  })

  test("#given a running child #then steer and follow-up go through gated admissions with steer and queue delivery, and settlement reads the transcript", async () => {
    // given
    const f = fixture()
    const child = await f.port.start({ sessionId: "root", generation: 1, prompt: "seed" })
    // when
    await child.steer("wake-2")
    await child.followUp("wake-3")
    f.setTranscript([
      { type: "user", text: "seed" },
      { type: "assistant", time: { created: 1 }, tokens: { input: 900, output: 1, reasoning: 0, cache: { read: 0, write: 0 } } },
      { type: "assistant", time: { created: Date.now() + 1 }, model: { providerID: "anthropic", id: "haiku" }, tokens: { input: 100, output: 7, reasoning: 0, cache: { read: 20, write: 0 } } },
    ])
    const report = await child.waitForIdle()
    // then
    expect(f.prompts.slice(1).map(prompt => [prompt.delivery, prompt.text])).toEqual([["steer", "wake-2"], ["queue", "wake-3"]])
    expect(report).toEqual({ status: "completed", model: "anthropic/haiku", usage: { input: 100, output: 7, cacheRead: 20, cacheWrite: 0 }, contextTokens: 120, userTexts: ["seed"] })
    await f.port.close()
  })

  test("#given an issued child #when it is disposed and the port closes #then the host child is interrupted, joined and removed and the durable row is CLOSED", async () => {
    // given
    const f = fixture()
    const child = await f.port.start({ sessionId: "root", generation: 1, prompt: "seed" })
    // when
    await child.dispose()
    await child.dispose()
    await f.port.close()
    // then
    expect(f.events).toEqual(["create", "prompt", "interrupt", "wait", "remove"])
    expect(f.sessions.has(child.sessionID)).toBe(false)
    expect(f.retired).toEqual([child.sessionID])
    const journal = await openChildJournal({ path: f.journalPath })
    const row = await journal.read(`kibitzer:1:${child.sessionID}`)
    journal.close()
    expect(row?.phase).toBe("closed")
  })

  test("#given a child left running #when only the port closes #then close still cleans the child", async () => {
    // given
    const f = fixture()
    const child = await f.port.start({ sessionId: "root", generation: 1, prompt: "seed" })
    // when
    await f.port.close()
    // then
    expect(f.events.slice(-3)).toEqual(["interrupt", "wait", "remove"])
    expect(f.retired).toEqual([child.sessionID])
    await expect(child.followUp("late")).rejects.toThrow()
  })
})

describe("kibitzer turn report", () => {
  test("#given an assistant error #then the turn is an error carrying its message", () => {
    // given
    const error = { name: "APIError", data: { statusCode: 503, message: "provider 503" } }
    const messages = [{ type: "assistant", time: { created: 5 }, error }]
    // when
    const report = turnReport(messages, 0)
    // then
    expect(report).toEqual({ status: "error", message: "provider 503", error, userTexts: [] })
  })
})
