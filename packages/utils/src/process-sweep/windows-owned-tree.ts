import { execFile } from "node:child_process"

export const WINDOWS_TREE_STEP_TIMEOUT_MS = 5_000

// Clock slack between Date.now() and the kernel's process creation times.
const CREATION_SLACK_MS = 1_000

export interface ProcessRow {
  readonly pid: number
  readonly ppid: number
  readonly createdAtMs: number
}

export function taskkillTree(pid: number): Promise<void> {
  return taskkill(["/PID", String(pid), "/T", "/F"])
}

/**
 * Ends what an exited root left running. Windows keeps a dead parent's pid as its children's parent id,
 * so the root's direct children are the rows naming it that were created between its spawn and its exit
 * (a later process reusing the pid cannot have been created in that window); their own descendants follow
 * by parent id. Each is killed with its tree.
 */
export async function killDescendantsOfExitedRoot(
  rootPid: number,
  spawnedAtMs: number,
  exitedAtMs: number,
): Promise<readonly number[]> {
  const rows = await processSnapshot()
  const victims = descendantsOfExitedRoot(rows, rootPid, spawnedAtMs, exitedAtMs)
  if (victims.length > 0) await taskkill(["/F", "/T", ...victims.flatMap((pid) => ["/PID", String(pid)])])
  return victims
}

export function descendantsOfExitedRoot(
  rows: readonly ProcessRow[],
  rootPid: number,
  spawnedAtMs: number,
  exitedAtMs: number,
): number[] {
  const byParent = new Map<number, ProcessRow[]>()
  for (const row of rows) byParent.set(row.ppid, [...(byParent.get(row.ppid) ?? []), row])
  const found: number[] = []
  const queue = (byParent.get(rootPid) ?? []).filter(
    (row) =>
      row.pid !== rootPid &&
      row.createdAtMs >= spawnedAtMs - CREATION_SLACK_MS &&
      row.createdAtMs <= exitedAtMs + CREATION_SLACK_MS,
  )
  while (queue.length > 0) {
    const row = queue.shift()
    if (row === undefined || found.includes(row.pid)) continue
    found.push(row.pid)
    for (const child of byParent.get(row.pid) ?? [])
      if (child.createdAtMs >= row.createdAtMs - CREATION_SLACK_MS) queue.push(child)
  }
  return found
}

function processSnapshot(): Promise<ProcessRow[]> {
  const script =
    "Get-CimInstance Win32_Process | ForEach-Object { '{0} {1} {2}' -f $_.ProcessId, $_.ParentProcessId, " +
    "([DateTimeOffset]$_.CreationDate).ToUnixTimeMilliseconds() }"
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
    const [pid, ppid, createdAtMs] = line.trim().split(" ").map(Number)
    if (Number.isInteger(pid) && Number.isInteger(ppid) && Number.isFinite(createdAtMs))
      rows.push({ pid: pid as number, ppid: ppid as number, createdAtMs: createdAtMs as number })
  }
  return rows
}

function taskkill(args: readonly string[]): Promise<void> {
  return new Promise((resolve) => {
    execFile("taskkill.exe", [...args], { windowsHide: true, timeout: WINDOWS_TREE_STEP_TIMEOUT_MS }, () => resolve())
  })
}
