import { createHash, randomUUID } from "node:crypto"
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises"
import { dirname, join } from "node:path"
import { createLockRecord, GitMemoryRepo, withLock } from "@oh-my-opencode/memory-core"
import type { SessionContext } from "@opencode/plugin/promise/session"
import type { Context } from "@opencode/plugin/promise/plugin"
import type { Registration } from "@opencode/plugin/promise/registration"
import { describeError, type BoundMemorySession, type MemoryBinder } from "./binding"
import type { MemoryLogger } from "./config"
import { isRecord } from "./session-metadata"

interface AcceptedTurns {
  readonly version: 1
  readonly sessionID: string
  readonly turns: number
  readonly messageID: string
}

export function createAcceptedTurns(binder: MemoryBinder, logger: MemoryLogger) {
  const states = new Map<string, AcceptedTurns>()
  const chains = new Map<string, Promise<void>>()
  const scans = new Map<string, { head: string; saved: number }>()

  function pathFor(bound: BoundMemorySession): string {
    const key = createHash("sha256").update(bound.sessionID).digest("hex")
    return join(bound.paths.runtime, "accepted-turns", `${key}.json`)
  }

  async function load(bound: BoundMemorySession): Promise<AcceptedTurns> {
    try {
      const value: unknown = JSON.parse(await readFile(pathFor(bound), "utf8"))
      if (!isRecord(value) || value.version !== 1 || value.sessionID !== bound.sessionID ||
          typeof value.turns !== "number" || !Number.isSafeInteger(value.turns) || value.turns < 0 ||
          typeof value.messageID !== "string") throw new Error("Invalid accepted-turn record")
      return { version: 1, sessionID: bound.sessionID, turns: value.turns, messageID: value.messageID }
    } catch (error) {
      if (!isRecord(error) || error.code !== "ENOENT") throw error
      return { version: 1, sessionID: bound.sessionID, turns: 0, messageID: "" }
    }
  }

  async function turns(sessionID: string): Promise<number> {
    await chains.get(sessionID)
    if (!states.has(sessionID)) {
      const bound = await binder.resolve(sessionID)
      if (bound !== undefined) states.set(sessionID, await load(bound))
    }
    return states.get(sessionID)?.turns ?? 0
  }

  const counter = {
    turns,
    hasActivity: (sessionID: string) => (states.get(sessionID)?.turns ?? 0) > 0,
    async onPrompt(sessionID: string, messageID: string): Promise<void> {
      const next = (chains.get(sessionID) ?? Promise.resolve()).then(async () => {
        const bound = await binder.resolve(sessionID)
        if (bound === undefined) return
        const file = pathFor(bound)
        await mkdir(dirname(file), { recursive: true })
        await withLock(`${file}.lock`, await createLockRecord("v2-memory-accepted-turns"), async () => {
          const previous = await load(bound)
          const current: AcceptedTurns = previous.messageID === messageID ? previous : { ...previous, turns: previous.turns + 1, messageID }
          const temporary = `${file}.${randomUUID()}.tmp`
          try {
            await writeFile(temporary, `${JSON.stringify(current)}\n`, { flag: "wx" })
            await rename(temporary, file)
          } finally {
            await rm(temporary, { force: true })
          }
          states.set(sessionID, current)
        }, { waitTimeoutMs: 5_000 })
      }).catch((error: unknown) => {
        logger.warn("memory accepted-turn bookkeeping skipped", { sessionID, error: describeError(error) })
      })
      chains.set(sessionID, next)
      await next
    },
    async onContext(context: Pick<SessionContext, "sessionID" | "system">): Promise<void> {
      if (context.system.some(part => part.metadata?.["omo.memory.save-nudge"] === true)) return
      const bound = await binder.resolve(context.sessionID)
      if (bound === undefined) return
      const settings = { ...bound.settings.nudge, ...bound.settings.agents[bound.identity]?.nudge }
      if (!settings.enabled) return
      try {
        const count = await turns(context.sessionID)
        if (count < settings.every_user_turns) return
        const repo = new GitMemoryRepo({ dir: bound.paths.repo, agentId: bound.identity })
        const head = await repo.head()
        let saved = 0
        if (head !== null) {
          const previous = scans.get(context.sessionID)
          saved = previous?.saved ?? 0
          if (previous?.head !== head) {
            const commits = await repo.log({ grep: ["Omo-Writer: memory-tool", `Omo-Session: ${context.sessionID}`], limit: 20, timeoutMs: 5_000,
              ...(previous === undefined ? {} : { range: `${previous.head}..${head}` }) })
            const latest = commits.find(commit => commit.trailers["Omo-Writer"] === "memory-tool" &&
              commit.trailers["Omo-Session"] === context.sessionID && /^\d+$/.test(commit.trailers["Omo-Turn"] ?? ""))
            const candidate = Number(latest?.trailers["Omo-Turn"])
            if (Number.isSafeInteger(candidate) && candidate >= 0) saved = candidate
            scans.set(context.sessionID, { head, saved })
          }
        }
        const pending = count - saved
        if (pending >= settings.every_user_turns) context.system.push({ type: "text",
          text: `${pending} accepted user turns since your last memory save. Save durable facts now, or decide nothing qualifies.`,
          metadata: { "omo.memory.save-nudge": true, turns: pending } })
      } catch (error) {
        logger.warn("memory save reminder skipped", { sessionID: context.sessionID, error: describeError(error) })
      }
    },
    async settled(): Promise<void> { await Promise.all(chains.values()) },
  }
  return {
    turns: counter.turns,
    hasActivity: counter.hasActivity,
    onContext: counter.onContext,
    settled: counter.settled,
    register(events: Context["event"]): Registration {
      const stop = new AbortController()
      const work = (async () => {
        try {
          for await (const event of events.subscribe({ types: ["session.inbox.enqueued"], signal: stop.signal })) {
            if (stop.signal.aborted) break
            if (event.type !== "session.inbox.enqueued" || event.data.item.type !== "user") continue
            await counter.onPrompt(event.data.sessionID, event.data.inboxID)
          }
        } catch (error) {
          if (!stop.signal.aborted) logger.warn("memory accepted-turn event stream failed", { error: describeError(error) })
        }
      })()
      return { async dispose() { stop.abort(); await work } }
    },
  }
}
