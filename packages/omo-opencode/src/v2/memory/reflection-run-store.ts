// Durable pieces of one V2 reflection run, laid out exactly where Senpi lays them so either host can
// recover the other's leftovers:
// - the reservation store over `<identity reflection>/{active.lock,pending.json,park.json}` (memory-core
//   `ReflectionReservationStore`, trigger config from the per-identity reflection settings);
// - `<identity reflection>/runs/<runId>/prelaunch.json` written before `git worktree add`, as Senpi's
//   `create-run-worktree.ts` does, so a launcher that dies mid-run leaves the worktree identity behind;
// - `<identity reflection>/runs/<runId>/transcript-payload.json` = `{schemaVersion: 1, runId, request}`
//   (Senpi `spawn-payload.ts`), made read-only after writing;
// - the seeded memory repo and the cross-process writer lock (`memory-write`), opened through
//   `memory-repo-open.ts` like the memory tool and the facts runner.
// V2 never writes Senpi's `ledger.json` / `outcome.json`: the child is in-process and dies with its host.

import {
  createReflectionWorktree, type GitMemoryRepo, REFLECTION_PARK_DETAIL_MAX_CHARS, ReflectionReservationStore,
  sanitizeToSlug, TranscriptJournal, type ReflectionLauncherIdentity, type ReflectionWorktree, type ReservedRun,
} from "@oh-my-opencode/memory-core"
import { chmod, mkdir, readFile, rm, writeFile } from "@oh-my-opencode/memory-core/fs"
import type { OmoMemoryReflection } from "@oh-my-opencode/omo-config-core"
import { join } from "node:path"
import type { BoundMemorySession } from "./binding"
import { memoryWriterLock as sharedWriterLock, type WriterLock } from "./memory-repo-open"

export interface ReflectionStoreSeams {
  readonly createRunId?: () => string | Promise<string>
  readonly now?: () => Date
  readonly launcherIdentity?: () => Promise<ReflectionLauncherIdentity>
}

/** Senpi `resolveAgentReflectionSettings`: the per-identity override over the root reflection block. */
export function reflectionSettings(bound: Pick<BoundMemorySession, "settings" | "identity">): OmoMemoryReflection {
  const base = bound.settings.reflection
  const override = bound.settings.agents[bound.identity]?.reflection
  return { ...base, ...override, trigger: { ...base.trigger, ...override?.trigger } }
}

export function reflectionStore(bound: BoundMemorySession, seams: ReflectionStoreSeams = {}): ReflectionReservationStore {
  const settings = reflectionSettings(bound)
  return new ReflectionReservationStore({
    identity: { id: bound.identity, safeSlug: sanitizeToSlug(bound.identity), paths: bound.paths },
    config: { stepCount: settings.trigger.step_count, onCompaction: settings.trigger.on_compaction },
    getJournal: async conversationId => new TranscriptJournal({ journalDir: join(bound.paths.transcripts, conversationId) }),
    ...(seams.createRunId === undefined ? {} : { createRunId: seams.createRunId }),
    ...(seams.now === undefined ? {} : { now: seams.now }),
    ...(seams.launcherIdentity === undefined ? {} : { launcherIdentity: seams.launcherIdentity }),
  })
}

export function reflectionRunDir(bound: Pick<BoundMemorySession, "paths">, runId: string): string {
  if (!/^[A-Za-z0-9._-]+$/.test(runId) || runId === "." || runId === "..") throw new TypeError(`unsafe reflection run id: ${runId}`)
  return join(bound.paths.reflection, "runs", runId)
}

export { openMemoryRepo, type WriterLock } from "./memory-repo-open"

/** The cross-process memory writer lock every parent-repo write takes. */
export function memoryWriterLock(bound: BoundMemorySession, waitTimeoutMs = 5_000): WriterLock {
  return sharedWriterLock(bound, `memory reflection (${bound.identity})`, { waitTimeoutMs })
}

interface ReflectionPrelaunch {
  readonly version: 1
  readonly runId: string
  readonly worktreeDir: string
  readonly worktreeBranch: string
}

/** Senpi `createRunWorktree`: `prelaunch.json` lands before the worktree; a failed create removes the run dir. */
export async function createRunWorktree(bound: BoundMemorySession, repo: GitMemoryRepo, runId: string): Promise<ReflectionWorktree> {
  const runDir = reflectionRunDir(bound, runId)
  try {
    return await createReflectionWorktree(repo, runId, bound.paths.worktrees, undefined, async identity => {
      await mkdir(runDir, { recursive: true, mode: 0o700 })
      const prelaunch: ReflectionPrelaunch = { version: 1, runId, worktreeDir: identity.dir, worktreeBranch: identity.branch }
      await writeFile(join(runDir, "prelaunch.json"), `${JSON.stringify(prelaunch, null, 2)}\n`, { encoding: "utf8", mode: 0o600 })
    })
  } catch (error) {
    await rm(runDir, { recursive: true, force: true })
    throw error
  }
}

export async function readPrelaunch(bound: BoundMemorySession, runId: string): Promise<ReflectionPrelaunch | undefined> {
  let value: unknown
  try {
    value = JSON.parse(await readFile(join(reflectionRunDir(bound, runId), "prelaunch.json"), "utf8"))
  } catch {
    return undefined
  }
  if (value === null || typeof value !== "object" || !("version" in value) || value.version !== 1) return undefined
  if (!("runId" in value) || value.runId !== runId || !("worktreeDir" in value) || !("worktreeBranch" in value)) return undefined
  const { worktreeDir, worktreeBranch } = value
  return typeof worktreeDir === "string" && typeof worktreeBranch === "string" ? { version: 1, runId, worktreeDir, worktreeBranch } : undefined
}

/**
 * The run's terminal sentinel, in Senpi's shapes: `final.json` once the reservation settled,
 * `abandoned.json` when recovery released a run whose launcher died. Senpi's orphan sweep treats a
 * run dir holding `prelaunch.json` and no sentinel as live, so every settled V2 run writes one.
 * `final.json` also keeps the failure `detail` (bounded like the park record's): V2 writes no Senpi
 * `outcome.json`, and a manual run never reaches the park file, so this is where a `spawn_failed` cause lands.
 */
export async function writeRunTerminal(bound: BoundMemorySession, run: ReservedRun, terminal:
  | { readonly kind: "final"; readonly outcome: string; readonly reason?: string; readonly detail?: string; readonly integrationSha?: string; readonly at: string }
  | { readonly kind: "abandoned"; readonly reason: string; readonly at: string },
): Promise<void> {
  const runDir = reflectionRunDir(bound, run.runId)
  const generation = run.reservedAt ?? terminal.at
  const value = terminal.kind === "final"
    ? {
      version: 1, runId: run.runId, outcome: terminal.outcome, finishedAt: terminal.at, generation,
      ...(terminal.integrationSha === undefined ? {} : { integrationSha: terminal.integrationSha }),
      ...(terminal.reason === undefined ? {} : { reason: terminal.reason }),
      ...(terminal.detail === undefined ? {} : { detail: terminal.detail.slice(0, REFLECTION_PARK_DETAIL_MAX_CHARS) }),
    }
    : {
      version: 1, runId: run.runId, abandonedAt: terminal.at, reason: terminal.reason, generation,
      kind: run.request.trigger === "dream" ? "dream" : "reflection", trigger: run.request.trigger,
      ...(run.request.origin === undefined ? {} : { origin: run.request.origin }),
      launcher: { pid: run.launcherPid, hostname: run.launcherHostname, processStart: run.launcherProcessStart ?? null },
    }
  await mkdir(runDir, { recursive: true, mode: 0o700 })
  await writeFile(join(runDir, `${terminal.kind}.json`), `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", mode: 0o600 })
}

/** Senpi's transcript payload for the run; returns its path. */
export async function writeTranscriptPayload(bound: BoundMemorySession, run: ReservedRun): Promise<string> {
  const path = join(reflectionRunDir(bound, run.runId), "transcript-payload.json")
  await mkdir(reflectionRunDir(bound, run.runId), { recursive: true, mode: 0o700 })
  await writeFile(path, `${JSON.stringify({ schemaVersion: 1, runId: run.runId, request: run.request }, null, 2)}\n`, { encoding: "utf8", mode: 0o600 })
  await chmod(path, 0o400)
  return path
}
