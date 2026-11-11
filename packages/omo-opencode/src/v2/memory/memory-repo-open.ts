// The one way V2 opens (and, on a brand-new identity, seeds) the parent memory repo. Every seeding path
// (the facts runner, the reflection run store, the memory tool) goes through `openMemoryRepo`, so the
// seed commit only ever happens under the cross-process `memory-write` lock. Seeding outside that lock
// races a locked seeder on git's own `index.lock`, which the memory-core stranded-lock sweep then refuses
// to clear because its holder is this live host (the S7h "Stranded git lock file(s)" spawn failure).
// Senpi seeds the same way: `prepareMemoryEngineSession` initializes the repo inside its writer lock.

import { createLockRecord, GitMemoryRepo, initMemoryWithSeeds, memoryWriterLockPath, withLock, type MemoryIdentityPaths } from "@oh-my-opencode/memory-core"
import { existsSync, mkdir } from "@oh-my-opencode/memory-core/fs"
import { join } from "node:path"

export interface MemoryRepoTarget {
  readonly identity: string
  readonly paths: Pick<MemoryIdentityPaths, "repo" | "locks">
}

export type WriterLock = <T>(operation: () => Promise<T>) => Promise<T>

export interface WriterLockOptions {
  /** Writer-lock wait budget before contention is reported; defaults to 5000ms. */
  readonly waitTimeoutMs?: number
  readonly retryDelayMs?: number
}

/** The cross-process `memory-write` lock every parent-repo write takes; `holder` labels the lock record. */
export function memoryWriterLock(target: MemoryRepoTarget, holder: string, options: WriterLockOptions = {}): WriterLock {
  return async operation => {
    await mkdir(target.paths.locks, { recursive: true, mode: 0o700 })
    const record = await createLockRecord(holder)
    return withLock(memoryWriterLockPath(target.paths.locks), record, operation, {
      waitTimeoutMs: options.waitTimeoutMs ?? 5_000,
      ...(options.retryDelayMs === undefined ? {} : { retryDelayMs: options.retryDelayMs }),
    })
  }
}

/**
 * The parent repo with its seed commit. `.git` alone is not enough: a seeder creates `.git` under the
 * writer lock before it commits the seeds, so a repo without a HEAD is waited for under that lock and
 * seeded there when nobody finished it. The unlocked probe only reads (`.git` presence and HEAD), so an
 * already seeded repo never touches the lock.
 */
export async function openMemoryRepo(target: MemoryRepoTarget, lock: WriterLock): Promise<GitMemoryRepo> {
  const repo = new GitMemoryRepo({ dir: target.paths.repo, agentId: target.identity })
  const seeded = async (): Promise<boolean> => existsSync(join(target.paths.repo, ".git")) && await repo.head() !== null
  if (!await seeded()) {
    await lock(async () => {
      if (!await seeded()) await initMemoryWithSeeds(repo, { authorName: target.identity })
    })
  }
  return repo
}
