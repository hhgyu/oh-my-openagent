import { createHash } from "node:crypto"
import {
  buildIdentityPaths, isAutoAgentValue, resolveAutoIdentity, resolveMemoryIdentity, type MemoryIdentityPaths,
} from "@oh-my-opencode/memory-core"
import type { OmoMemorySettings } from "@oh-my-opencode/omo-config-core"
import { resolveSafeMemoryRoot, type MemoryEnv, type MemoryLogger } from "./config"
import { isRecord, type MemorySessionPort, type SessionMetadataStore } from "./session-metadata"

export const MEMORY_BINDING_KEY = "omo.memory.binding"

export interface MemorySessionBinding {
  readonly version: 1
  readonly identity: string
  readonly repoPathHash: string
  readonly boundAt: number
}

/** A root session bound to one memory identity. Holding one never implies its storage exists. */
export interface BoundMemorySession {
  readonly sessionID: string
  readonly identity: string
  readonly paths: MemoryIdentityPaths
  readonly settings: OmoMemorySettings
  readonly directory: string
  /** Session metadata as read at bind time (the projection pin is seeded from it). */
  readonly metadata: Readonly<Record<string, unknown>>
}

export interface MemoryBinderDeps {
  readonly session: Pick<MemorySessionPort, "get">
  readonly metadata: SessionMetadataStore
  readonly env: MemoryEnv
  readonly home?: string
  readonly now: () => number
  readonly loadSettings: (cwd: string) => OmoMemorySettings
  readonly logger: MemoryLogger
  /** Called once per successful bind (Senpi's `session_start` edge); must not throw. */
  readonly onBound?: (bound: BoundMemorySession) => void
}

export interface MemoryBinder {
  /** The binding for a root session; `undefined` for child, disabled, refused or conflicting sessions. */
  resolve(sessionID: string): Promise<BoundMemorySession | undefined>
  forget(sessionID: string): void
  clear(): void
}

export function createMemoryBinder(deps: MemoryBinderDeps): MemoryBinder {
  const bound = new Map<string, Promise<BoundMemorySession | undefined>>()

  async function bind(sessionID: string): Promise<BoundMemorySession | undefined> {
    const info = await deps.session.get({ sessionID })
    // Only the parent writes: a subagent child never binds, reads, or projects memory.
    if (info.parentID !== undefined && info.parentID !== null) return undefined
    const directory = info.location.directory
    const settings = deps.loadSettings(directory)
    if (!settings.enabled) return undefined
    const root = resolveSafeMemoryRoot(deps.env, directory, deps.home)
    if (!root.ok) {
      deps.logger.warn("memory refused an unsafe memory root", { sessionID, root: root.root, reason: root.reason })
      return undefined
    }
    const env = { ...deps.env }
    const resolved = isAutoAgentValue(settings.agent)
      ? resolveAutoIdentity(directory, env, settings.auto_identity)
      : resolveMemoryIdentity(settings.agent, directory, env)
    const metadata: Readonly<Record<string, unknown>> = info.metadata ?? {}
    const adopted = adoptIdentity(readBinding(metadata), { id: resolved.id, paths: resolved.paths }, root.root, settings.agent)
    if (adopted === undefined) {
      deps.logger.warn("memory binding failed closed: session is bound to another identity", { sessionID, resolved: resolved.id })
      return undefined
    }
    const binding: MemorySessionBinding = {
      version: 1, identity: adopted.id, repoPathHash: hashRepoPath(adopted.paths.repo), boundAt: deps.now(),
    }
    const recorded = readBinding(metadata)
    if (recorded?.identity !== binding.identity || recorded.repoPathHash !== binding.repoPathHash) {
      await deps.metadata.write(sessionID, MEMORY_BINDING_KEY, { ...binding })
    }
    const bound: BoundMemorySession = { sessionID, identity: adopted.id, paths: adopted.paths, settings, directory, metadata }
    deps.onBound?.(bound)
    return bound
  }

  return {
    resolve(sessionID) {
      let pending = bound.get(sessionID)
      if (pending === undefined) {
        pending = bind(sessionID).catch((error: unknown) => {
          bound.delete(sessionID)
          deps.logger.warn("memory session bind skipped", { sessionID, error: describeError(error) })
          return undefined
        })
        bound.set(sessionID, pending)
      }
      return pending
    },
    forget: sessionID => { bound.delete(sessionID) },
    clear: () => { bound.clear() },
  }
}

interface Identity { readonly id: string; readonly paths: MemoryIdentityPaths }

/**
 * The recorded binding wins over a freshly resolved auto identity (one host serves many workspaces), as
 * in Senpi's identity adoption. An explicit `memory.agent` naming another identity, or a record whose
 * repository cannot be reproduced under the current root, fails closed.
 */
function adoptIdentity(recorded: MemorySessionBinding | undefined, resolved: Identity, root: string, agent: string): Identity | undefined {
  if (recorded === undefined) return resolved
  if (recorded.identity === resolved.id) return recorded.repoPathHash === hashRepoPath(resolved.paths.repo) ? resolved : undefined
  if (!isAutoAgentValue(agent)) return undefined
  const adopted = { id: recorded.identity, paths: buildIdentityPaths(root, recorded.identity) }
  return recorded.repoPathHash === hashRepoPath(adopted.paths.repo) ? adopted : undefined
}

function readBinding(metadata: Readonly<Record<string, unknown>>): MemorySessionBinding | undefined {
  const value = metadata[MEMORY_BINDING_KEY]
  if (!isRecord(value) || value.version !== 1) return undefined
  const { identity, repoPathHash, boundAt } = value
  if (typeof identity !== "string" || typeof repoPathHash !== "string" || typeof boundAt !== "number") return undefined
  return { version: 1, identity, repoPathHash, boundAt }
}

function hashRepoPath(repoPath: string): string {
  return createHash("sha256").update(repoPath, "utf8").digest("hex")
}

export function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

