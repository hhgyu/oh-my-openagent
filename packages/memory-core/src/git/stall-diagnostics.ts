import { spawn, type ChildProcess } from "node:child_process"
import { randomUUID } from "node:crypto"
import { join } from "node:path"

import { mkdir, rename, rm, writeFile } from "../fs/resilient"
import { GIT_TIMEOUT_DIAGNOSTICS_ENV, snapshotCommand } from "./timeout-diagnostics"
import { publishVolumeSnapshotEvidence } from "./volume-snapshot-diagnostics"

// The timeout record (timeout-diagnostics.ts) is written when git's own budget runs out. On Windows CI that
// budget (30 s) equals Bun's per-test timeout, which fires first and kills the git, so a stalled git under a
// test never reached its record. In diagnostics mode, a git still running at half its budget now records the
// process table and the volume snapshot evidence while it is still stalled. Nothing waits for it: the record
// is taken asynchronously and the git keeps its budget. Short budgets (tests that time a git out on purpose)
// are left alone, since half of them is not a stall.
export const GIT_STALL_MIN_BUDGET_MS = 10_000
const SNAPSHOT_DEADLINE_MS = 15_000
const MAX_SNAPSHOT_BYTES = 4 * 1024 * 1024

export type StallSnapshot = (pid: number) => Promise<string>

export interface GitStallRecordOptions {
  readonly snapshot?: StallSnapshot
  readonly publishVolume?: (recordPath: string) => Promise<void>
  readonly onRecorded?: (recordPath: string | undefined) => void
}

function snapshotProcesses(pid: number): Promise<string> {
  const [file, args] = snapshotCommand(pid)
  return new Promise((resolve) => {
    const output: Buffer[] = []
    let bytes = 0
    const child = spawn(file, [...args], { stdio: ["ignore", "pipe", "pipe"], windowsHide: true })
    const keep = (chunk: Buffer) => {
      if (bytes < MAX_SNAPSHOT_BYTES) output.push(chunk)
      bytes += chunk.length
    }
    const text = () => Buffer.concat(output).toString("utf8")
    const timer = setTimeout(() => {
      child.kill("SIGKILL")
      resolve(`process snapshot failed: not finished within ${SNAPSHOT_DEADLINE_MS} ms\n${text()}`)
    }, SNAPSHOT_DEADLINE_MS)
    child.stdout.on("data", keep)
    child.stderr.on("data", keep)
    child.once("error", (error) => {
      clearTimeout(timer)
      resolve(`process snapshot failed: ${error.message}`)
    })
    child.once("close", () => {
      clearTimeout(timer)
      resolve(text())
    })
  })
}

async function recordGitStall(
  directory: string,
  pid: number,
  argv: readonly string[],
  cwd: string,
  timeoutMs: number,
  startedAt: number,
  options: GitStallRecordOptions,
): Promise<string | undefined> {
  const at = new Date()
  const recordPath = join(directory, `git-stall-${pid}-${at.getTime()}.json`)
  const temp = `${recordPath}.tmp-${process.pid}-${randomUUID()}`
  try {
    const processes = await (options.snapshot ?? snapshotProcesses)(pid)
    const record = {
      at: at.toISOString(),
      pid,
      cwd,
      timeoutMs,
      runningForMs: at.getTime() - startedAt,
      argv: argv.slice(0, 12),
      argCount: argv.length,
      processes,
    }
    await mkdir(directory, { recursive: true })
    await writeFile(temp, `${JSON.stringify(record, null, 2)}\n`, { flag: "wx" })
    await rename(temp, recordPath)
  } catch (error) {
    process.stderr.write(`git stall diagnostics could not be written to ${directory}: ${String(error)}\n`)
    await rm(temp, { force: true }).catch(() => undefined)
    return undefined
  }
  await (options.publishVolume ?? publishVolumeSnapshotEvidence)(recordPath)
  return recordPath
}

/** Arms the half-budget stall record for a spawned git; the child's exit or spawn error disarms it. */
export function armGitStallRecord(
  child: ChildProcess,
  environment: NodeJS.ProcessEnv,
  argv: readonly string[],
  cwd: string,
  timeoutMs: number,
  options: GitStallRecordOptions = {},
): void {
  const directory = environment[GIT_TIMEOUT_DIAGNOSTICS_ENV]
  const pid = child.pid
  if (!directory || pid === undefined || timeoutMs < GIT_STALL_MIN_BUDGET_MS) return
  const startedAt = Date.now()
  const timer = setTimeout(
    () => {
      void recordGitStall(directory, pid, argv, cwd, timeoutMs, startedAt, options).then(options.onRecorded)
    },
    Math.floor(timeoutMs / 2),
  )
  timer.unref()
  const disarm = () => clearTimeout(timer)
  child.once("exit", disarm)
  child.once("error", disarm)
}
