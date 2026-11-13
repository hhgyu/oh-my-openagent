import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test"
import { join } from "node:path"
import { TranscriptJournal, type ReflectionEvent, type ReservationResult } from "@oh-my-opencode/memory-core"
import { OmoMemorySettingsSchema } from "@oh-my-opencode/omo-config-core"
import type { BoundMemorySession } from "./binding"
import { reflectionStore } from "./reflection-run-store"
import { createReflectionTriggers, type ReflectionTriggerDeps } from "./reflection-triggers"
import { createBoundIdentity } from "./reflection.test-support"

setDefaultTimeout(process.platform === "win32" ? 60_000 : 20_000)

const cleanups: (() => void)[] = []
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup()
})

const user = (id: string, text = "hello") => ({ type: "user", id, text })
const answer = (id: string, extra: Record<string, unknown> = {}) => ({
  type: "assistant",
  id,
  content: [{ type: "text", text: `answer ${id}` }],
  time: { created: 1, completed: 2 },
  ...extra,
})

function setup(
  options: {
    readonly reflection?: Record<string, unknown>
    readonly realStore?: boolean
    readonly owned?: boolean
    readonly active?: boolean
    readonly child?: boolean
  } = {},
) {
  const identity = createBoundIdentity()
  cleanups.push(identity.cleanup)
  const bound: BoundMemorySession = {
    ...identity.bound,
    settings: OmoMemorySettingsSchema.parse({ reflection: options.reflection ?? {} }),
  }
  const transcript: { messages: unknown[] } = { messages: [] }
  const events: ReflectionEvent[] = []
  const results: (ReservationResult | null)[] = []
  let contextReads = 0
  let runs = 0
  const turns: string[] = []
  const deps: ReflectionTriggerDeps = {
    resolve: async (sessionID) => (options.child === true || sessionID !== bound.sessionID ? undefined : bound),
    onTurnSettled: async (target) => {
      turns.push(target.sessionID)
    },
    session: {
      context: async () => {
        contextReads++
        return structuredClone(transcript.messages) as never
      },
    },
    evaluate: async (target, event) => {
      events.push(event)
      if (options.realStore !== true) return null
      const result = await reflectionStore(target, { createRunId: () => `run-${++runs}` }).evaluate(
        target.sessionID,
        event,
      )
      results.push(result)
      return result
    },
    hasUserActivity: () => options.active !== false,
    isOwnedSession: () => options.owned === true,
    logger: { warn: () => undefined },
  }
  const triggers = createReflectionTriggers(deps)
  cleanups.push(() => {
    void triggers.close()
  })
  /** Journals the transcript as the memory journal's idle reconcile does before the trigger runs. */
  const journal = async (steps: number) => {
    const projections = Array.from({ length: steps }, (_, index) => [
      { kind: "user" as const, messageId: `u${index}`, text: `question ${index}` },
      {
        kind: "assistant" as const,
        messageId: `a${index}`,
        textBlocks: [`answer ${index}`],
        reasoningBlocks: [],
        toolCalls: [],
      },
    ]).flat()
    await new TranscriptJournal({ journalDir: join(bound.paths.transcripts, bound.sessionID) }).reconcile(projections)
  }
  const idle = async () => {
    triggers.onIdle(bound.sessionID)
    await triggers.settled()
  }
  return { bound, transcript, events, results, triggers, journal, idle, turns, contextReads: () => contextReads }
}

describe("reflection triggers", () => {
  test("#given a turn that ended normally #when the session goes idle #then one successful settle is evaluated", async () => {
    // given
    const { transcript, events, idle } = setup()
    transcript.messages = [user("u1"), answer("a1"), { type: "synthetic", id: "s1", text: "note" }]
    // when
    await idle()
    // then
    expect(events).toEqual([{ kind: "settled", success: true }])
  })

  test("#given turns that ended aborted, errored, retrying or unanswered #when the session goes idle #then no settle is evaluated", async () => {
    // given
    const { transcript, events, idle } = setup()
    const endings = [
      [user("u1"), answer("a1", { error: { type: "aborted", message: "interrupted by user" } })],
      [user("u1"), answer("a1", { finish: "error" })],
      [
        user("u1"),
        answer("a1", {
          retry: { attempt: 1, at: 3, error: { type: "api", message: "overloaded" } },
          time: { created: 1 },
        }),
      ],
      [user("u1"), answer("a1"), user("u2")],
      [],
    ]
    // when
    for (const messages of endings) {
      transcript.messages = messages
      await idle()
    }
    // then
    expect(events).toEqual([])
  })

  test("#given a journal at the step threshold #when the session settles twice #then exactly one step-count run is reserved with this session's snapshot", async () => {
    // given
    const { bound, transcript, results, journal, idle } = setup({
      reflection: { trigger: { step_count: 2, on_compaction: false } },
      realStore: true,
    })
    transcript.messages = [user("u1"), answer("a1")]
    await journal(1)
    await idle()
    // when
    await journal(2)
    await idle()
    await idle()
    // then
    const active = results.filter((result) => result?.status === "active")
    expect(results.map((result) => result?.status ?? null)).toEqual([null, "active", null])
    expect(active).toHaveLength(1)
    const run = active[0]?.status === "active" ? active[0].run : undefined
    expect(run?.request.trigger).toBe("step-count")
    expect(run?.request.conversationIds).toEqual([bound.sessionID])
    expect(run?.request.snapshots.map((snapshot) => snapshot.conversationId)).toEqual([bound.sessionID])
  })

  test("#given an accepted compaction #when the next turns settle #then compaction is recorded once before the settle and fires a compaction run", async () => {
    // given
    const { transcript, events, results, triggers, bound, journal, idle } = setup({
      reflection: { trigger: { step_count: 0, on_compaction: true } },
      realStore: true,
    })
    await journal(1)
    transcript.messages = [user("u1"), answer("a1", { error: { type: "aborted", message: "stop" } })]
    triggers.onCompaction(bound.sessionID)
    await idle()
    // when
    transcript.messages = [user("u1"), answer("a1")]
    await idle()
    await idle()
    // then
    expect(events.map((event) => event.kind)).toEqual(["compaction_accepted", "settled", "settled"])
    const run = results[1]?.status === "active" ? results[1].run : undefined
    expect(run?.request.trigger).toBe("compaction")
  })

  test("#given reflection disabled for the identity #when a compacted session settles #then nothing is evaluated and the pending compaction is dropped", async () => {
    // given
    const { transcript, events, triggers, bound, idle } = setup({ reflection: { enabled: false } })
    transcript.messages = [user("u1"), answer("a1")]
    triggers.onCompaction(bound.sessionID)
    // when
    await idle()
    // then
    expect(events).toEqual([])
  })

  test("#given owned children, child sessions and sessions without user input #when they go idle or compact #then nothing is read or evaluated", async () => {
    // given
    const owned = setup({ owned: true })
    const child = setup({ child: true })
    const silent = setup({ active: false })
    for (const each of [owned, child, silent]) each.transcript.messages = [user("u1"), answer("a1")]
    // when
    for (const each of [owned, child, silent]) {
      each.triggers.onCompaction(each.bound.sessionID)
      await each.idle()
    }
    // then
    expect([owned.events, child.events, silent.events]).toEqual([[], [], []])
    expect([owned.contextReads(), child.contextReads(), silent.contextReads()]).toEqual([0, 0, 0])
    expect([owned.turns, child.turns, silent.turns]).toEqual([[], [], []])
  })

  test("#given a bound root session with user input #when turns settle, failed or with reflection disabled #then the stale reflection-lock check runs once per settled turn", async () => {
    // given
    const enabled = setup()
    const disabled = setup({ reflection: { enabled: false } })
    enabled.transcript.messages = [user("u1"), answer("a1", { finish: "error" })]
    disabled.transcript.messages = [user("u1"), answer("a1")]
    // when
    await enabled.idle()
    await enabled.idle()
    await disabled.idle()
    // then
    expect(enabled.turns).toEqual([enabled.bound.sessionID, enabled.bound.sessionID])
    expect(disabled.turns).toEqual([disabled.bound.sessionID])
    expect([enabled.events, disabled.events]).toEqual([[], []])
  })

  test("#given a closed trigger set #when the session goes idle #then nothing is scheduled", async () => {
    // given
    const { transcript, events, triggers, idle } = setup()
    transcript.messages = [user("u1"), answer("a1")]
    await triggers.close()
    // when
    await idle()
    // then
    expect(events).toEqual([])
  })
})
