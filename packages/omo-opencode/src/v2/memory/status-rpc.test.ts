import { afterEach, describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { buildIdentityPaths, TranscriptJournal } from "@oh-my-opencode/memory-core"
import { OmoMemorySettingsSchema } from "@oh-my-opencode/omo-config-core"
import type { BoundMemorySession } from "./binding"
import { createMemoryStatusRpc, MEMORY_STATUS_RPC_ID, MEMORY_UPDATED_EVENT, type MemoryStatusRpcPort } from "./status-rpc"
import type { MemoryRpcSync } from "./sync/ports"

const roots: string[] = []
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })

interface Emitted { readonly name: string; readonly data: Record<string, unknown> }

function harness(sync: (repo: string) => MemoryRpcSync | undefined = () => undefined) {
  const root = mkdtempSync(join(tmpdir(), "omo-v2-status-rpc-"))
  roots.push(root)
  const emitted: Emitted[] = []
  let status: Parameters<MemoryStatusRpcPort["register"]>[1]["status"] | undefined
  const rpc: MemoryStatusRpcPort = {
    register: async (definition, handlers) => {
      expect(definition.id).toBe(MEMORY_STATUS_RPC_ID)
      status = handlers.status
      return { dispose: async () => undefined, events: { emit: async (name, data) => { emitted.push({ name, data }) } } }
    },
  }
  const component = createMemoryStatusRpc({ syncStatus: async repo => sync(repo), logger: { warn: () => undefined }, debounceMs: 5 })
  const bound = (sessionID: string, identity = "me"): BoundMemorySession => ({
    sessionID, identity, directory: root, metadata: {}, settings: OmoMemorySettingsSchema.parse({}), paths: buildIdentityPaths(root, identity),
  })
  const callStatus = (sessionID: string): Promise<Record<string, unknown>> => {
    if (status === undefined) throw new Error("status is not registered")
    return status({ sessionID }, { signal: new AbortController().signal, error: () => { throw new Error("no declared errors") } })
  }
  return { component, rpc, emitted, bound, callStatus }
}

async function journal(session: BoundMemorySession, answers: number, state: Record<string, unknown>): Promise<void> {
  const journalDir = join(session.paths.transcripts, session.sessionID)
  const projections = Array.from({ length: answers }, (_, index) => [
    { kind: "user" as const, messageId: `u${index}`, text: `question ${index}` },
    { kind: "assistant" as const, messageId: `a${index}`, textBlocks: [`answer ${index}`], reasoningBlocks: [], toolCalls: [] },
  ]).flat()
  await new TranscriptJournal({ journalDir }).reconcile(projections)
  writeFileSync(join(journalDir, "state.json"), JSON.stringify(state))
}

const settle = () => Bun.sleep(30)

describe("omo.memory status RPC", () => {
  test("#given a bound session with a journal and a syncing repo #when status is called #then the snapshot carries journal, reflection and sync fields", async () => {
    // given
    const h = harness(() => ({ state: "synced", lastSyncedAtISO: "2026-11-12T00:00:00.000Z" }))
    await h.component.register(h.rpc)
    const session = h.bound("s1")
    h.component.onBound(session)
    await journal(session, 3, { reflected_completed_steps: 1, consecutive_failures: 2, pending_compaction: true, last_reflection_succeeded_at: "2026-11-11T10:00:00.000Z" })

    // when
    const snapshot = await h.callStatus("s1")

    // then
    expect(snapshot).toEqual({
      schemaVersion: 1, identity: "me", sessionID: "s1",
      journal: { sessionId: "s1", totalSteps: 3, reflectedSteps: 1 },
      reflection: { backlogSteps: 2, pendingCompaction: true, consecutiveFailures: 2, lastConsolidationAtISO: "2026-11-11T10:00:00.000Z" },
      sync: { state: "synced", lastSyncedAtISO: "2026-11-12T00:00:00.000Z" },
    })
  })

  test("#given a session that never bound #when status is called #then it answers unavailable", async () => {
    // given
    const h = harness()
    await h.component.register(h.rpc)

    // when
    const answer = await h.callStatus("unknown")

    // then
    expect(answer.kind).toBe("unavailable")
  })

  test("#given two sessions on one repo and one on another #when that repo changes in a burst #then one updated event per session on it, and an unchanged repeat is not republished", async () => {
    // given
    const h = harness()
    await h.component.register(h.rpc)
    for (const session of [h.bound("a"), h.bound("b"), h.bound("c", "other")]) h.component.onBound(session)
    const repo = h.bound("a").paths.repo

    // when
    h.component.refreshRepo(repo)
    h.component.refreshRepo(repo)
    await settle()
    await h.component.settled()
    const first = h.emitted.map(event => [event.name, event.data.sessionID])
    h.component.refreshRepo(repo)
    await settle()
    await h.component.settled()

    // then
    expect(first.sort()).toEqual([[MEMORY_UPDATED_EVENT, "a"], [MEMORY_UPDATED_EVENT, "b"]])
    expect(h.emitted).toHaveLength(2)
  })

  test("#given a published session #when its journal settles with new steps #then a fresh updated event follows", async () => {
    // given
    const h = harness()
    await h.component.register(h.rpc)
    const session = h.bound("s1")
    h.component.onBound(session)
    h.component.refreshSession("s1")
    await h.component.settled()

    // when
    await journal(session, 1, {})
    h.component.refreshSession("s1")
    await h.component.settled()

    // then
    expect(h.emitted.map(event => (event.data.journal as { totalSteps: number }).totalSteps)).toEqual([0, 1])
  })

  test("#given the component closed #when a repo change arrives #then nothing is published", async () => {
    // given
    const h = harness()
    await h.component.register(h.rpc)
    h.component.onBound(h.bound("a"))
    h.component.close()

    // when
    h.component.refreshRepo(h.bound("a").paths.repo)
    h.component.refreshSession("a")
    await settle()

    // then
    expect(h.emitted).toEqual([])
  })
})
