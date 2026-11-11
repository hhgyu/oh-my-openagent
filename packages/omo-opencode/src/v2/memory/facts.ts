// OpenCode 2 facts runtime (Senpi `facts-wiring.ts` + `wiring-static.ts` + `wiring-runtime.ts`).
// Senpi -> OpenCode mapping:
// - `input`/`input_disposition` user activity -> `session.hook("prompt")` marks real user input;
// - `agent_settled` -> `experimental.idle`: a bound root session with real user input since its last
//   settle enqueues its journal delta into memory-core's `FactsQueue`; the settle-count debounce
//   (`memory.facts.debounce_settles`, default 4, counted per identity) launches the extractor, and a
//   session's first settle launches at once when a previous process left pending batches;
// - `session_shutdown` final delta -> none exists, so a session bound in an earlier process enqueues
//   its last delta at its next bind, and every bind reconciles stranded runs (`facts-recovery.ts`);
// - the in-process senpi child -> an owned hidden `omo-facts` child whose only tool is `record_fact`
//   (`facts-child.ts`); the parent applies the batch (`facts-finalize.ts`).
// `memory.facts.enabled` (and the per-identity override) is read per call. Children never bind.

import { randomUUID } from "node:crypto"
import { join } from "node:path"
import { TranscriptJournal, type FactsPeopleRouting } from "@oh-my-opencode/memory-core"
import type { OmoConfig, OmoMemorySettings } from "@oh-my-opencode/omo-config-core"
import type * as Plugin from "@opencode/plugin/promise/plugin"
import { loadRuntimeConfig } from "../config/runtime"
import type { CatalogModel } from "../host/model-catalog"
import { describeError, MEMORY_BINDING_KEY, type BoundMemorySession, type MemoryBinder } from "./binding"
import type { MemoryLogger } from "./config"
import type { FactsChildHosting } from "./facts-child"
import { availableFactsModels, resolveFactsModel } from "./facts-model"
import { factsOwnerAlive, retireFactsOwner, registerFactsOwner } from "./facts-owners"
import { createFactsRunner, type FactsRunner } from "./facts-runner"

/** Native in-process memory child deadline. */
const FACTS_CHILD_DEADLINE_MS = 5 * 60_000

interface MemoryFactsDeps {
  readonly binder: MemoryBinder
  readonly session: Pick<Plugin.Context["session"], "context">
  readonly logger: MemoryLogger
  readonly now: () => number
  readonly loadSettings: (cwd: string) => OmoMemorySettings
  readonly hosting: FactsChildHosting
  /** Live catalog; absent means no model can be resolved and no launch happens. */
  readonly catalog?: () => Promise<readonly CatalogModel[]>
  readonly loadConfig?: (cwd: string) => OmoConfig
  readonly deadlineMs?: number
}

interface IdentityState {
  readonly runner: FactsRunner
  settles: number
  readonly settled: Set<string>
  lastSession: string
  lastSessionModel?: string
}

export interface MemoryFacts {
  isFactsSession(sessionID: string): boolean
  onPrompt(sessionID: string): void
  onIdle(sessionID: string): Promise<void>
  onBound(bound: BoundMemorySession): Promise<void>
  /** `/facts retry`: one launch attempt for the session's identity. */
  retry(sessionID: string): Promise<void>
  settled(): Promise<void>
  close(): Promise<void>
}

export function createMemoryFacts(deps: MemoryFactsDeps): MemoryFacts {
  const owner = randomUUID()
  registerFactsOwner(owner)
  const loadConfig = deps.loadConfig ?? ((cwd: string) => loadRuntimeConfig({ cwd }).config)
  const states = new Map<string, IdentityState>()
  const userInput = new Set<string>()
  const work = new Set<Promise<unknown>>()
  let closed = false

  function track(promise: Promise<unknown>, label: string): void {
    const tracked = promise.catch((error: unknown) => { deps.logger.warn(`facts ${label} failed`, { error: describeError(error) }) })
    work.add(tracked)
    void tracked.finally(() => { work.delete(tracked) })
  }

  function factsSettings(bound: BoundMemorySession): { readonly enabled: boolean; readonly debounce: number } {
    const settings = deps.loadSettings(bound.directory)
    const override = settings.agents[bound.identity]?.facts
    return { enabled: override?.enabled ?? settings.facts.enabled, debounce: Math.max(1, override?.debounce_settles ?? settings.facts.debounce_settles) }
  }

  function stateFor(bound: BoundMemorySession): IdentityState {
    const existing = states.get(bound.paths.root)
    if (existing !== undefined) return existing
    const runner = createFactsRunner({
      identity: bound.identity, paths: bound.paths, owner, now: () => new Date(deps.now()), logger: deps.logger,
      deadlineMs: deps.deadlineMs ?? FACTS_CHILD_DEADLINE_MS, ownerAlive: factsOwnerAlive,
      people: () => peopleRouting(loadConfig(bound.directory), bound.identity),
      resolveModel: async sessionModel => {
        const config = loadConfig(bound.directory)
        const available = deps.catalog === undefined ? undefined : availableFactsModels(await deps.catalog(), config)
        return resolveFactsModel(config, available, sessionModel, bound.identity)
      },
      launchChild: input => deps.hosting.launch(bound, input),
      reclaimChildren: () => deps.hosting.reclaim(bound),
    })
    const state: IdentityState = { runner, settles: 0, settled: new Set(), lastSession: bound.sessionID }
    states.set(bound.paths.root, state)
    return state
  }

  function launch(state: IdentityState): void {
    const request = { parentSessionId: state.lastSession, ...(state.lastSessionModel === undefined ? {} : { sessionModel: state.lastSessionModel }) }
    track(state.runner.launchPending(request), "extractor launch")
  }

  async function enqueue(bound: BoundMemorySession, state: IdentityState): Promise<void> {
    const entries = await new TranscriptJournal({ journalDir: join(bound.paths.transcripts, bound.sessionID) }).readEntries()
    if (entries.length === 0) return
    await state.runner.queue.enqueue({ identity: bound.identity, sessionId: bound.sessionID, conversationId: bound.sessionID, entries })
  }

  async function settle(sessionID: string): Promise<void> {
    const bound = await deps.binder.resolve(sessionID)
    if (bound === undefined || closed || !factsSettings(bound).enabled) return
    const state = stateFor(bound)
    state.lastSession = sessionID
    const model = await latestSessionModel(deps.session, sessionID)
    if (model !== undefined) state.lastSessionModel = model
    const leftovers = state.settled.has(sessionID) ? [] : await state.runner.queue.listPending().catch(() => [])
    await enqueue(bound, state)
    if (closed) return
    state.settled.add(sessionID)
    state.settles += 1
    if (leftovers.length > 0 || state.settles >= factsSettings(bound).debounce) {
      state.settles = 0
      launch(state)
    }
  }

  return {
    isFactsSession: sessionID => deps.hosting.isFactsSession(sessionID),
    onPrompt(sessionID) {
      if (!closed && !deps.hosting.isFactsSession(sessionID)) userInput.add(sessionID)
    },
    async onIdle(sessionID) {
      // Only a settle after real user input enqueues; the mark is spent by this settle.
      if (closed || deps.hosting.isFactsSession(sessionID) || !userInput.delete(sessionID)) return
      const run = settle(sessionID)
      track(run, "settle")
      await run.catch(() => undefined)
    },
    async onBound(bound) {
      if (closed || !factsSettings(bound).enabled) return
      const state = stateFor(bound)
      state.settled.delete(bound.sessionID)
      const run = (async () => {
        // A binding recorded by an earlier process means this session may hold an un-enqueued final delta.
        if (bound.metadata[MEMORY_BINDING_KEY] !== undefined) await enqueue(bound, state)
        await state.runner.reconcilePending()
      })()
      track(run, "bind reconcile")
      await run.catch(() => undefined)
    },
    async retry(sessionID) {
      const bound = await deps.binder.resolve(sessionID)
      if (bound === undefined || closed || !factsSettings(bound).enabled) return
      const state = stateFor(bound)
      state.lastSession = sessionID
      launch(state)
    },
    async settled() {
      while (work.size > 0) await Promise.allSettled([...work])
    },
    async close() {
      closed = true
      await Promise.allSettled([...states.values()].map(state => state.runner.cancelActive()))
      while (work.size > 0) await Promise.allSettled([...work])
      deps.hosting.close()
      states.clear()
      userInput.clear()
      retireFactsOwner(owner)
    },
  }
}

/** Native `resolveFactsPeopleRouting`: per-identity override, then the root `memory.people` block. */
function peopleRouting(config: OmoConfig, identity: string): FactsPeopleRouting {
  const memory = config.memory
  const override = memory?.agents[identity]?.people
  return {
    enabled: override?.enabled ?? memory?.people.enabled ?? true,
    maxEntries: override?.max_entries ?? memory?.people.max_entries ?? 40,
    maxEntryChars: override?.max_entry_chars ?? memory?.people.max_entry_chars ?? 200,
  }
}

/** `provider/model` of the session's newest assistant message, tolerant of unknown message shapes. */
export async function latestSessionModel(session: MemoryFactsDeps["session"], sessionID: string): Promise<string | undefined> {
  let messages: readonly unknown[]
  try {
    messages = await session.context({ sessionID })
  } catch {
    return undefined
  }
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index]
    if (message === null || typeof message !== "object" || !("type" in message) || message.type !== "assistant" || !("model" in message)) continue
    const model = message.model
    if (model !== null && typeof model === "object" && "providerID" in model && "id" in model && typeof model.providerID === "string" && typeof model.id === "string") {
      return `${model.providerID}/${model.id}`
    }
  }
  return undefined
}
