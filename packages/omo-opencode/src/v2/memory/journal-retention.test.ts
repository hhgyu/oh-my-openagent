import { afterEach, describe, expect, test } from "bun:test"
import { OmoMemorySettingsSchema } from "@oh-my-opencode/omo-config-core"
import { TranscriptJournal } from "@oh-my-opencode/memory-core"
import type { BoundMemorySession } from "./binding"
import { createMemoryJournal } from "./journal"
import { createBoundIdentity } from "./reflection.test-support"

const cleanups: (() => void)[] = []
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup()
})

describe("memory journal retention", () => {
  test("#given more sessions than the retention bound #when each reconciles #then inactive journals are released and the active one is reused", async () => {
    // given
    const identity = createBoundIdentity()
    cleanups.push(identity.cleanup)
    const created: string[] = []
    const journal = createMemoryJournal({
      binder: { resolve: async () => undefined, forget: () => undefined, clear: () => undefined },
      session: { context: async () => [] },
      logger: { warn: () => undefined },
      createJournal: (dir) => {
        created.push(dir)
        return new TranscriptJournal({ journalDir: dir })
      },
    })
    const bind = (sessionID: string): BoundMemorySession => ({
      ...identity.bound,
      sessionID,
      settings: OmoMemorySettingsSchema.parse({}),
    })

    // when
    await journal.onBound(bind("active"))
    for (let index = 0; index < 40; index += 1) {
      await journal.onBound(bind(`idle-${index}`))
      await journal.onBound(bind("active"))
    }
    await journal.onBound(bind("idle-0"))

    // then
    expect(created.filter((dir) => dir.endsWith("active"))).toHaveLength(1)
    expect(created.filter((dir) => dir.endsWith("idle-0"))).toHaveLength(2)
  })
})
