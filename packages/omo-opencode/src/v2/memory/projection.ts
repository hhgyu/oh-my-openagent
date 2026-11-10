import { existsSync } from "@oh-my-opencode/memory-core/fs"
import { join } from "node:path"
import { GitMemoryRepo, compileMemoryBlockAtRevision, markMemoryBlock, revisionExists } from "@oh-my-opencode/memory-core"
import type { SessionContext } from "@opencode/plugin/promise/session"
import { describeError, type BoundMemorySession, type MemoryBinder } from "./binding"
import type { MemoryLogger } from "./config"
import { isRecord, type SessionMetadataStore } from "./session-metadata"

/** System-part metadata marker: at most one memory block per model request. */
export const MEMORY_PART_MARKER = "omo.memory"
export const PROJECTION_PIN_KEY = "omo.memory.projection-pin"
const MAX_COMPILED_BLOCKS = 64

/**
 * The revision and instant a session's memory block is compiled at. Later commits never change the
 * projected bytes (prompt-cache stability, Senpi #8470); the pin moves only after a compaction or when
 * the pinned commit no longer exists.
 */
export interface ProjectionPin {
  readonly version: 1
  readonly sessionId: string
  readonly revision: string | null
  readonly pinnedAtMs: number
}

export interface MemoryProjectionDeps {
  readonly binder: MemoryBinder
  readonly metadata: SessionMetadataStore
  readonly now: () => number
  readonly logger: MemoryLogger
}

export interface MemoryProjection {
  onContext(context: Pick<SessionContext, "sessionID" | "system">): Promise<void>
  /** A compaction makes the prompt cache cold: the next request repins at HEAD. */
  markCompacted(sessionID: string): void
  clear(): void
}

export function createMemoryProjection(deps: MemoryProjectionDeps): MemoryProjection {
  const pins = new Map<string, ProjectionPin>()
  const compacted = new Set<string>()
  const blocks = new Map<string, Promise<string>>()

  async function currentPin(bound: BoundMemorySession, repo: GitMemoryRepo): Promise<ProjectionPin> {
    const live = pins.get(bound.sessionID)
    if (!compacted.has(bound.sessionID)) {
      if (live !== undefined) return live
      const stored = readPin(bound.metadata, bound.sessionID)
      if (stored !== undefined && (stored.revision === null || await revisionExists(repo, stored.revision))) {
        pins.set(bound.sessionID, stored)
        return stored
      }
    }
    const fresh: ProjectionPin = { version: 1, sessionId: bound.sessionID, revision: await repo.head(), pinnedAtMs: deps.now() }
    pins.set(bound.sessionID, fresh)
    compacted.delete(bound.sessionID)
    // The pin is persisted so a host restart reproduces the same bytes; a failed write only costs that.
    await deps.metadata.write(bound.sessionID, PROJECTION_PIN_KEY, { ...fresh }).catch((error: unknown) => {
      deps.logger.warn("memory projection pin was not persisted", { sessionID: bound.sessionID, error: describeError(error) })
    })
    return fresh
  }

  function compile(repo: GitMemoryRepo, bound: BoundMemorySession, pin: ProjectionPin): Promise<string> {
    const limits = bound.settings.projection
    const key = [bound.identity, pin.revision ?? "", pin.pinnedAtMs, limits.max_entries_per_directory, limits.max_bytes].join("\0")
    let block = blocks.get(key)
    if (block === undefined) {
      block = compileMemoryBlockAtRevision(repo, pin.revision, {
        agentId: bound.identity,
        projection: { maxEntriesPerDirectory: limits.max_entries_per_directory, maxBytes: limits.max_bytes },
      }, pin.pinnedAtMs)
      blocks.set(key, block)
      block.catch(() => blocks.delete(key))
      if (blocks.size > MAX_COMPILED_BLOCKS) blocks.delete(blocks.keys().next().value ?? key)
    }
    return block
  }

  return {
    async onContext(context) {
      if (carriesMemoryBlock(context.system)) return
      const bound = await deps.binder.resolve(context.sessionID)
      if (bound === undefined) return
      // Reads never create storage: an identity without a repository projects nothing.
      if (!existsSync(join(bound.paths.repo, ".git"))) return
      try {
        const repo = new GitMemoryRepo({ dir: bound.paths.repo, agentId: bound.identity })
        const block = await compile(repo, bound, await currentPin(bound, repo))
        if (carriesMemoryBlock(context.system)) return
        context.system.push({ type: "text", text: markMemoryBlock(bound.identity, block), metadata: { [MEMORY_PART_MARKER]: true } })
      } catch (error) {
        deps.logger.warn("memory projection skipped", { sessionID: context.sessionID, error: describeError(error) })
      }
    },
    markCompacted(sessionID) {
      compacted.add(sessionID)
    },
    clear() {
      pins.clear()
      compacted.clear()
      blocks.clear()
    },
  }
}

function carriesMemoryBlock(system: SessionContext["system"]): boolean {
  return system.some(part => part.metadata?.[MEMORY_PART_MARKER] === true)
}

/** The pin this session wrote; a fork's copied metadata names the parent session and is ignored. */
function readPin(metadata: Readonly<Record<string, unknown>>, sessionID: string): ProjectionPin | undefined {
  const value = metadata[PROJECTION_PIN_KEY]
  if (!isRecord(value) || value.version !== 1 || value.sessionId !== sessionID) return undefined
  const { revision, pinnedAtMs } = value
  if ((revision !== null && typeof revision !== "string") || typeof pinnedAtMs !== "number" || !Number.isFinite(pinnedAtMs)) return undefined
  return { version: 1, sessionId: sessionID, revision, pinnedAtMs }
}
