// V2 memory sync lifetime. Senpi acquires the sync runner per session at `session_start` and releases
// it with the binding; V2 has no single current session, so this holds ONE acquire per distinct bound
// repo for the component's lifetime and releases them all in cleanup. The sync host (runner, account
// source, RPC coordinator) and the Loro engine under it load only on the first enabled bind or the
// first `omo.memory.sync` call: this file imports nothing but types and `./ports`.
//
// A fresh device binds before its memory repo exists (the first memory write seeds it), and the
// runner's space resolution writes the repo's git config, so an acquire then fails and the runner
// keeps that failed start held. A repo without its git config therefore waits instead of acquiring,
// and is acquired on the next bind or settle edge once a write has seeded it. A failed acquisition
// never keeps its slot: the next edge tries again.

import { randomUUID } from "node:crypto"
import { join } from "node:path"
import { existsSync } from "@oh-my-opencode/memory-core/fs"
import type { SyncRpcContext } from "@oh-my-opencode/memory-core/sync-runner"
import { describeError, type BoundMemorySession } from "../binding"
import type { MemoryEnv, MemoryLogger } from "../config"
import { syncEnabled, type MemoryRpcSync, type MemorySyncSeams, type SyncHost, type SyncHostModule, type SyncRpcVerb } from "./ports"

export interface MemorySyncRuntimeOptions {
  readonly env: MemoryEnv
  readonly memoryRoot: string
  readonly logger: MemoryLogger
  /** A repo changed (HEAD moved, or its shown sync failure changed): the status snapshot is stale. */
  readonly onRepoChanged: (repo: string) => void
  readonly seams?: MemorySyncSeams
}

export interface MemorySyncRuntime {
  /** Acquires the repo's sync once, on its first enabled bind; never throws. */
  onBound(bound: BoundMemorySession): void
  /** A session settled: acquires every waiting repo that a write has seeded since; never throws. */
  onSettled(): void
  /** The repo's `sync` snapshot field; undefined without loading the host when nothing acquired. */
  status(repo: string): Promise<MemoryRpcSync | undefined>
  /** One `omo.memory.sync` verb on behalf of this component's single RPC owner. */
  call(verb: SyncRpcVerb, data: unknown): Promise<unknown>
  /** Resolves once every acquire started so far has settled. */
  settled(): Promise<void>
  /** Retires the RPC owner, releases every acquired repo, then disposes the coordinator. */
  close(): Promise<void>
}

const UNAVAILABLE = { kind: "unavailable", reason: "Memory sync is not available in this session." } as const

export function createMemorySyncRuntime(options: MemorySyncRuntimeOptions): MemorySyncRuntime {
  const loadModule = options.seams?.loadHost ?? ((): Promise<SyncHostModule> => import("./host"))
  const lifetime = new AbortController()
  // One owner per registration: OpenCode passes no connection identity, and a per-call signal would
  // end a pairing ceremony as soon as its first call returned.
  const owner: SyncRpcContext = {
    ownerId: `opencode-v2:${randomUUID()}`,
    disconnectSignal: lifetime.signal,
    admit: dispatch => { lifetime.signal.throwIfAborted(); return dispatch() },
  }
  const acquisitions = new Map<string, Promise<boolean>>()
  // Repos bound before their repository existed, waiting for the write that seeds them.
  const waiting = new Map<string, BoundMemorySession>()
  const seeded = (bound: BoundMemorySession): boolean => existsSync(join(bound.paths.repo, ".git", "config"))
  let latestRepo: string | undefined
  let loaded: Promise<SyncHost> | undefined
  let closed = false

  const host = (): Promise<SyncHost> => {
    loaded ??= loadModule().then(module => module.createSyncHost({
      env: options.env, memoryRoot: options.memoryRoot, logger: options.logger, signal: lifetime.signal,
      onStatusChange: repo => { if (!closed) options.onRepoChanged(repo) },
      onHeadChange: repo => { if (!closed) options.onRepoChanged(repo) },
      syncStatus: () => latestRepo === undefined ? Promise.resolve(undefined) : status(latestRepo),
      ...(options.seams?.accountSource === undefined ? {} : { source: options.seams.accountSource }),
    })).catch((error: unknown) => {
      // A failed load is not cached: the next bind or call retries.
      loaded = undefined
      throw error
    })
    return loaded
  }

  async function status(repo: string): Promise<MemoryRpcSync | undefined> {
    if (loaded === undefined || !acquisitions.has(repo)) return undefined
    try {
      return await (await host()).rpcSync(repo)
    } catch (error) {
      options.logger.warn("memory sync status read failed", { repo, error: describeError(error) })
      return undefined
    }
  }

  const acquire = (bound: BoundMemorySession): void => {
    const repo = bound.paths.repo
    const attempt = (async () => {
      let loadedHost: SyncHost
      try {
        loadedHost = await host()
      } catch (error) {
        options.logger.warn("memory sync host could not be loaded", { identity: bound.identity, error: describeError(error) })
        return false
      }
      if (closed) return false
      try {
        await loadedHost.acquire(bound.identity, bound.paths, { profile: bound.settings.agent, projectDir: bound.directory })
        return true
      } catch (error) {
        options.logger.warn("memory sync could not start for this memory", { identity: bound.identity, error: describeError(error) })
        // Keep the runner's refcount balanced, so the next attempt starts a fresh engine.
        await loadedHost.release(repo).catch((releaseError: unknown) => {
          options.logger.warn("memory sync release after a failed start failed", { identity: bound.identity, error: describeError(releaseError) })
        })
        return false
      }
    })()
    acquisitions.set(repo, attempt)
    void attempt.then(acquired => {
      if (acquired || acquisitions.get(repo) !== attempt) return
      acquisitions.delete(repo)
      // Back to waiting: the next bind or settle edge tries again, never a timer.
      if (!closed) waiting.set(repo, bound)
    })
  }

  const acquireSeeded = (): void => {
    for (const [repo, bound] of waiting) {
      if (closed || acquisitions.has(repo) || !seeded(bound)) continue
      waiting.delete(repo)
      acquire(bound)
    }
  }

  return {
    onBound(bound) {
      if (closed || !syncEnabled(bound)) return
      const repo = bound.paths.repo
      latestRepo = repo
      if (!acquisitions.has(repo) && !waiting.has(repo)) waiting.set(repo, bound)
      acquireSeeded()
    },
    onSettled() {
      if (!closed) acquireSeeded()
    },
    status,
    async call(verb, data) {
      if (closed) return UNAVAILABLE
      let loadedHost: SyncHost
      try {
        loadedHost = await host()
      } catch (error) {
        options.logger.warn("memory sync host could not be loaded", { error: describeError(error) })
        return UNAVAILABLE
      }
      return loadedHost.call(verb, data, owner)
    },
    async settled() {
      await Promise.allSettled([...acquisitions.values()])
    },
    async close() {
      if (closed) return
      closed = true
      lifetime.abort()
      waiting.clear()
      const repos: string[] = []
      for (const [repo, acquired] of acquisitions) if (await acquired) repos.push(repo)
      acquisitions.clear()
      if (loaded === undefined) return
      const loadedHost = await loaded.catch(() => undefined)
      if (loadedHost === undefined) return
      const results = await Promise.allSettled(repos.map(repo => loadedHost.release(repo)))
      results.push(...await Promise.allSettled([loadedHost.dispose()]))
      const failures = results.filter((result): result is PromiseRejectedResult => result.status === "rejected")
      if (failures.length > 0) throw new AggregateError(failures.map(failure => failure.reason), "Memory sync cleanup failed")
    },
  }
}
