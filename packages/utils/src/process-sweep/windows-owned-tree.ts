import { execFile } from "node:child_process"

import { terminateExactProcess } from "./win32-process-handle"

export const WINDOWS_TREE_STEP_TIMEOUT_MS = 5_000

// Win32_Process.CreationDate carries microseconds; GetProcessTimes carries 100 ns ticks.
const CIM_CREATION_TOLERANCE_TICKS = 10n

export interface ProcessRow {
  readonly pid: number
  readonly ppid: number
  readonly creationTicks: bigint
}

export interface OwnedRootIdentity {
  readonly pid: number
  readonly creationTicks: bigint
  /** Required once the root is gone from the snapshot: it bounds when the root could still create children. */
  readonly exitTicks?: bigint | null
}

export function taskkillTree(pid: number): Promise<void> {
  return new Promise((resolve) => {
    execFile(
      "taskkill.exe",
      ["/PID", String(pid), "/T", "/F"],
      { windowsHide: true, timeout: WINDOWS_TREE_STEP_TIMEOUT_MS },
      () => resolve(),
    )
  })
}

/**
 * The live processes provably created by the owned root or by one of its proven descendants, from one snapshot.
 * The caller holds a handle to the root for the whole run, so the root's pid cannot have been reused: a row naming
 * it as parent and created after it was created by it. Below the root, a link is followed only to a parent that is
 * alive in the same snapshot and was created no later than the child, so the parent pid belonged to that very
 * process when the child was created. A root that already exited could only create children before its exit, so
 * its direct children must also predate `exitTicks`; without that exit time, or with a row holding the root's pid
 * under another creation time, nothing is selected: an identity that is not proven is never killed.
 */
export function ownedDescendants(rows: readonly ProcessRow[], root: OwnedRootIdentity): ProcessRow[] {
  const holder = rows.find((row) => row.pid === root.pid)
  if (holder !== undefined && !sameCreation(holder.creationTicks, root.creationTicks)) return []
  const rootExit = root.exitTicks ?? null
  if (holder === undefined && rootExit === null) return []
  const byParent = new Map<number, ProcessRow[]>()
  for (const row of rows) {
    const siblings = byParent.get(row.ppid)
    if (siblings === undefined) byParent.set(row.ppid, [row])
    else siblings.push(row)
  }
  const selected: ProcessRow[] = []
  const seen = new Set<number>([root.pid])
  const queue: OwnedRootIdentity[] = [root]
  while (queue.length > 0) {
    const parent = queue.shift()
    if (parent === undefined) break
    for (const row of byParent.get(parent.pid) ?? []) {
      if (seen.has(row.pid) || row.creationTicks + CIM_CREATION_TOLERANCE_TICKS < parent.creationTicks) continue
      if (parent === root && rootExit !== null && row.creationTicks > rootExit + CIM_CREATION_TOLERANCE_TICKS) continue
      seen.add(row.pid)
      selected.push(row)
      queue.push(row)
    }
  }
  return selected
}

/** Terminates the owned root's live descendants, each by handle after re-checking its exact creation time. */
export async function killOwnedDescendants(root: OwnedRootIdentity): Promise<readonly number[]> {
  const victims = ownedDescendants(await processSnapshot(), root)
  const killed: number[] = []
  for (const victim of victims)
    if (await terminateExactProcess(victim.pid, victim.creationTicks, CIM_CREATION_TOLERANCE_TICKS))
      killed.push(victim.pid)
  return killed
}

function sameCreation(left: bigint, right: bigint): boolean {
  return (left > right ? left - right : right - left) <= CIM_CREATION_TOLERANCE_TICKS
}

function processSnapshot(): Promise<ProcessRow[]> {
  const script =
    "Get-CimInstance Win32_Process | ForEach-Object { '{0} {1} {2}' -f $_.ProcessId, $_.ParentProcessId, " +
    "$_.CreationDate.ToFileTimeUtc() }"
  return new Promise((resolve) => {
    execFile(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-Command", script],
      { encoding: "utf8", windowsHide: true, timeout: WINDOWS_TREE_STEP_TIMEOUT_MS, maxBuffer: 16 * 1024 * 1024 },
      (_error, stdout) => resolve(parseSnapshot(String(stdout ?? ""))),
    )
  })
}

function parseSnapshot(text: string): ProcessRow[] {
  const rows: ProcessRow[] = []
  for (const line of text.split(/\r?\n/)) {
    const match = /^(\d+) (\d+) (\d+)$/.exec(line.trim())
    if (match === null) continue
    rows.push({ pid: Number(match[1]), ppid: Number(match[2]), creationTicks: BigInt(match[3] ?? "0") })
  }
  return rows
}
