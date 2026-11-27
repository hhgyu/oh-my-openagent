import { randomUUID } from "node:crypto"
import { hostname } from "node:os"

import { osFileLockAvailable } from "./os-file-lock"
import { getProcessStartIdentity } from "./process-identity"

export type LockRecord = {
  readonly pid: number
  readonly process_start: string
  readonly hostname: string
  readonly nonce: string
  readonly created_at: string
  readonly purpose: string
  readonly run_id?: string
  // This process runs its memory-core git under the kernel git-activity lock (omo #10322), so an
  // idle activity lock proves none of its git processes outlived it.
  readonly git_activity_lock?: true
  // A lock handed to a child process keeps the process that handed it over as a second owner:
  // the lock is dead only once both are, so the hand-over never leaves a window in which the
  // lock looks abandoned while its original owner is still about to release it.
  readonly co_owner?: LockCoOwner
}

export type LockCoOwner = {
  readonly pid: number
  readonly process_start: string
}

function parseCoOwner(value: unknown): LockCoOwner | null | undefined {
  if (value === undefined) return undefined
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null
  const candidate = value as Record<string, unknown>
  if (!Number.isInteger(candidate.pid) || Number(candidate.pid) <= 0) return null
  if (!isNonEmptyString(candidate.process_start)) return null
  return { pid: Number(candidate.pid), process_start: candidate.process_start }
}

export type CreateLockRecordOptions = {
  readonly runId?: string
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0
}

export function parseLockRecord(content: string): LockRecord | null {
  let value: unknown
  try {
    value = JSON.parse(content)
  } catch {
    return null
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null

  const candidate = value as Record<string, unknown>
  if (!Number.isInteger(candidate.pid) || Number(candidate.pid) <= 0) return null
  if (!isNonEmptyString(candidate.process_start)) return null
  if (!isNonEmptyString(candidate.hostname)) return null
  if (!isNonEmptyString(candidate.nonce)) return null
  if (!isNonEmptyString(candidate.created_at) || Number.isNaN(Date.parse(candidate.created_at))) return null
  if (!isNonEmptyString(candidate.purpose)) return null
  if (candidate.run_id !== undefined && !isNonEmptyString(candidate.run_id)) return null
  const coOwner = parseCoOwner(candidate.co_owner)
  if (coOwner === null) return null

  return {
    pid: Number(candidate.pid),
    process_start: candidate.process_start,
    hostname: candidate.hostname,
    nonce: candidate.nonce,
    created_at: candidate.created_at,
    purpose: candidate.purpose,
    ...(candidate.run_id === undefined ? {} : { run_id: candidate.run_id }),
    ...(candidate.git_activity_lock === true ? { git_activity_lock: true as const } : {}),
    ...(coOwner === undefined ? {} : { co_owner: coOwner }),
  }
}

export async function createLockRecord(purpose: string, options: CreateLockRecordOptions = {}): Promise<LockRecord> {
  if (purpose.length === 0) throw new Error("lock purpose must not be empty")
  const processStart = await getProcessStartIdentity(process.pid)
  return {
    pid: process.pid,
    process_start: processStart ?? "unavailable",
    hostname: hostname(),
    nonce: randomUUID(),
    created_at: new Date().toISOString(),
    purpose,
    ...(options.runId === undefined ? {} : { run_id: options.runId }),
    ...((await osFileLockAvailable()) ? { git_activity_lock: true as const } : {}),
  }
}
