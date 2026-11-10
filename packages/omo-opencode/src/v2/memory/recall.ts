import { join } from "node:path"
import {
  GitMemoryRepo, PendingNudges, RecallCorpusCache, RecallLedger, planRecallQueries, selectRecallCandidates, type RecallCandidate,
} from "@oh-my-opencode/memory-core"
import type { OmoMemoryRecall } from "@oh-my-opencode/omo-config-core"
import { existsSync } from "@oh-my-opencode/memory-core/fs"
import { describeError, type BoundMemorySession, type MemoryBinder } from "./binding"
import { resolveRecallSettings, type MemoryLogger } from "./config"

/** Ledger provenance for a delivered recall path; the value Senpi's drain records, kept for shared ledgers. */
export const RECALL_SURFACE_HASH = "kibitzer-gate"
const MAX_USER_TEXTS = 4

export interface RecallStores {
  ledger(bound: BoundMemorySession): Pick<RecallLedger, "surfacedPaths" | "markSurfaced">
  pending(bound: BoundMemorySession): Pick<PendingNudges, "take" | "write">
}

export const fileRecallStores: RecallStores = {
  ledger: bound => new RecallLedger(bound.paths.recallLedger),
  pending: bound => new PendingNudges(bound.paths.recallPending),
}

/** The resident Kibitzer judge: the only voice that turns a lexical candidate into a nudge. */
export interface RecallJudge {
  offer(bound: BoundMemorySession, candidates: readonly RecallCandidate[], surfaced: ReadonlySet<string>, recall: OmoMemoryRecall): Promise<unknown>
}

export interface MemoryRecallCollectorDeps {
  readonly binder: MemoryBinder
  readonly stores: RecallStores
  readonly corpusCache: RecallCorpusCache
  readonly logger: MemoryLogger
  /** Absent when the host cannot run the owned judge child: then nothing is collected or nudged. */
  readonly judge?: RecallJudge
}

/**
 * Lexical recall candidates for a root session. A user prompt and tool-call arguments plan the queries;
 * the session's ledger filters paths already surfaced; the candidates go to the Kibitzer judge, whose
 * accepted nudges are queued as pending nudges for the parent's next model request.
 */
export interface MemoryRecallCollector {
  observePrompt(sessionID: string, text: string): void
  observeToolInput(sessionID: string, input: unknown): void
  /** Resolves once every collection queued for the session has finished (never rejects). */
  settled(sessionID: string): Promise<void>
  /** Resolves once every collection has finished. */
  idle(): Promise<void>
  clear(): void
}

export function createRecallCollector(deps: MemoryRecallCollectorDeps): MemoryRecallCollector {
  const prompts = new Map<string, string[]>()
  const chains = new Map<string, Promise<void>>()

  const track = (sessionID: string, work: () => Promise<void>): void => {
    const next = (chains.get(sessionID) ?? Promise.resolve()).then(work).catch((error: unknown) => {
      // Read-only advice: a failed collection leaves the turn untouched.
      deps.logger.warn("memory recall collection skipped", { sessionID, error: describeError(error) })
    })
    chains.set(sessionID, next)
    void next.then(() => { if (chains.get(sessionID) === next) chains.delete(sessionID) })
  }

  async function collect(sessionID: string, prompt: string | undefined, toolText: string | undefined): Promise<void> {
    const judge = deps.judge
    if (judge === undefined) return
    const bound = await deps.binder.resolve(sessionID)
    if (bound === undefined) return
    const recall = resolveRecallSettings(bound.settings, bound.identity)
    if (!recall.enabled) return
    const texts = prompts.get(sessionID) ?? []
    if (prompt !== undefined && prompt.trim() !== "") {
      texts.push(prompt.slice(0, recall.event_caps.prompt))
      prompts.set(sessionID, texts.slice(-MAX_USER_TEXTS))
    }
    const userTexts = prompts.get(sessionID) ?? []
    const toolTexts = toolText === undefined ? [] : [toolText.slice(0, recall.event_caps.tool_args)]
    if (userTexts.length === 0 && toolTexts.length === 0) return
    // Reads never create storage: recall needs an existing repository.
    if (!existsSync(join(bound.paths.repo, ".git"))) return
    const queries = toolTexts.length === 0 ? planRecallQueries(userTexts) : planRecallQueries(userTexts, { toolTexts })
    if (queries.length === 0) return
    const corpus = await deps.corpusCache.load(new GitMemoryRepo({ dir: bound.paths.repo, agentId: bound.identity }))
    if (corpus.documents.length === 0) return
    const surfaced = await deps.stores.ledger(bound).surfacedPaths(sessionID)
    const candidates = selectRecallCandidates(corpus.documents, queries, { maxItems: recall.max_items, surfaced })
    if (candidates.length > 0) await judge.offer(bound, candidates, surfaced, recall)
  }

  return {
    observePrompt(sessionID, text) {
      track(sessionID, () => collect(sessionID, text, undefined))
    },
    observeToolInput(sessionID, input) {
      const text = toolArgumentText(input)
      if (text !== undefined) track(sessionID, () => collect(sessionID, undefined, text))
    },
    async settled(sessionID) {
      await chains.get(sessionID)
    },
    async idle() {
      await Promise.all([...chains.values()])
    },
    clear() {
      prompts.clear()
    },
  }
}

function toolArgumentText(input: unknown): string | undefined {
  if (typeof input === "string") return input.trim() === "" ? undefined : input
  try {
    const text = JSON.stringify(input)
    return text === undefined || text === "{}" || text === "null" ? undefined : text
  } catch {
    return undefined
  }
}
