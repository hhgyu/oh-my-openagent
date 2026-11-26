import { spawn } from "node:child_process"
import { randomUUID } from "node:crypto"

import { rename, rm, writeFile } from "../fs/resilient"

// Windows CI attributed a stalled `git add` to a Volume Shadow Copy snapshot only by process start times: VSSVC.exe
// started in the same second as the git that then waited past its timeout. The snapshot evidence itself (recent
// VSS / volsnap events and the VSSVC process) is collected after the git is signalled and published next to the
// timeout's record, which is never modified. Only the event log and the process table are read, so the VSS service
// is never started.
const VOLUME_SNAPSHOT_DEADLINE_MS = 10_000
const EVENT_WINDOW_MINUTES = 10
const MAX_EVENTS_PER_PROVIDER = 50
const MAX_OUTPUT_BYTES = 512 * 1024
const EVENT_PROVIDERS = ["VSS", "VSSVC", "volsnap", "Microsoft-Windows-VolumeSnapshot-Driver"] as const

export interface VolumeSnapshotEvent {
  readonly provider: string
  readonly log: string
  readonly id: number
  readonly level: string
  readonly timeUtc: string
  readonly message: string
}

export interface VolumeSnapshotEvidence {
  readonly windowMinutes: number
  readonly events: readonly VolumeSnapshotEvent[]
  readonly providerErrors: readonly { readonly provider: string; readonly error: string }[]
  readonly vssvc: readonly { readonly pid: number; readonly ppid: number; readonly createdUtc: string }[]
  readonly unparsed: readonly string[]
}

export interface CollectorRun {
  readonly stdout: string
  readonly stderr: string
  readonly exitCode: number | null
}

/** Runs the collector command; must settle (or reject) by the given deadline. */
export type VolumeSnapshotRunner = (args: readonly string[], deadlineMs: number) => Promise<CollectorRun>

export class VolumeSnapshotCollectorError extends Error {
  override readonly name = "VolumeSnapshotCollectorError"
  readonly exitCode: number | null
  readonly stderr: string
  readonly partial: VolumeSnapshotEvidence

  constructor(run: CollectorRun, partial: VolumeSnapshotEvidence) {
    super(
      run.exitCode === 0
        ? "volume snapshot collector wrote to stderr"
        : `volume snapshot collector exited ${String(run.exitCode)}`,
    )
    this.exitCode = run.exitCode
    this.stderr = run.stderr.slice(-4000)
    this.partial = partial
  }
}

function volumeSnapshotScript(windowMinutes: number): string {
  const providers = EVENT_PROVIDERS.map((name) => `'${name}'`).join(",")
  const json = "ConvertTo-Json -Compress"
  return [
    // Each provider is its own query: one that is not registered here, or fails outright, leaves the others intact.
    // try/catch takes terminating errors, -ErrorVariable the non-terminating ones such as "no events found".
    `foreach ($provider in @(${providers})) { try { $failure = $null; Get-WinEvent -LogName Application,System -MaxEvents ${MAX_EVENTS_PER_PROVIDER} -FilterXPath "*[System[Provider[@Name='$provider'] and TimeCreated[timediff(@SystemTime) &lt;= ${windowMinutes * 60_000}]]]" -ErrorAction SilentlyContinue -ErrorVariable failure | ForEach-Object { [pscustomobject]@{ kind = 'event'; provider = $_.ProviderName; log = $_.LogName; id = $_.Id; level = "$($_.LevelDisplayName)"; timeUtc = $_.TimeCreated.ToUniversalTime().ToString('o'); message = "$($_.Message)" -replace '\\s+', ' ' } | ${json} }; if ($failure) { [pscustomobject]@{ kind = 'providerError'; provider = $provider; error = "$($failure[0].Exception.Message)" } | ${json} } } catch { [pscustomobject]@{ kind = 'providerError'; provider = $provider; error = "$($_.Exception.Message)" } | ${json} } }`,
    `Get-CimInstance Win32_Process -Filter "Name='VSSVC.exe'" | ForEach-Object { [pscustomobject]@{ kind = 'vssvc'; pid = $_.ProcessId; ppid = $_.ParentProcessId; createdUtc = $_.CreationDate.ToUniversalTime().ToString('o') } | ${json} }`,
  ].join("; ")
}

function parseVolumeSnapshotOutput(output: string, windowMinutes: number): VolumeSnapshotEvidence {
  const events: VolumeSnapshotEvent[] = []
  const providerErrors: { provider: string; error: string }[] = []
  const vssvc: { pid: number; ppid: number; createdUtc: string }[] = []
  const unparsed: string[] = []
  for (const line of output.split(/\r?\n/)) {
    const text = line.trim()
    if (text === "") continue
    let row: Record<string, unknown>
    try {
      row = JSON.parse(text) as Record<string, unknown>
    } catch {
      unparsed.push(text.slice(0, 500))
      continue
    }
    const str = (key: string): string => (typeof row[key] === "string" ? (row[key] as string) : String(row[key] ?? ""))
    if (row["kind"] === "event") {
      events.push({
        provider: str("provider"),
        log: str("log"),
        id: Number(row["id"]),
        level: str("level"),
        timeUtc: str("timeUtc"),
        message: str("message").slice(0, 500),
      })
    } else if (row["kind"] === "providerError") providerErrors.push({ provider: str("provider"), error: str("error") })
    else if (row["kind"] === "vssvc")
      vssvc.push({ pid: Number(row["pid"]), ppid: Number(row["ppid"]), createdUtc: str("createdUtc") })
    else unparsed.push(text.slice(0, 500))
  }
  events.sort((left, right) => left.timeUtc.localeCompare(right.timeUtc))
  return { windowMinutes, events, providerErrors, vssvc, unparsed }
}

const runPowerShell: VolumeSnapshotRunner = (args, deadlineMs) =>
  new Promise((resolve, reject) => {
    const child = spawn("powershell", [...args], { stdio: ["ignore", "pipe", "pipe"], windowsHide: true })
    const stdout: Buffer[] = []
    const stderr: Buffer[] = []
    let bytes = 0
    const keep = (sink: Buffer[]) => (chunk: Buffer) => {
      if (bytes < MAX_OUTPUT_BYTES) sink.push(chunk)
      bytes += chunk.length
    }
    const timer = setTimeout(() => {
      child.kill()
      reject(new Error(`volume snapshot collector did not finish within ${deadlineMs} ms`))
    }, deadlineMs)
    child.stdout.on("data", keep(stdout))
    child.stderr.on("data", keep(stderr))
    child.once("error", (error) => {
      clearTimeout(timer)
      reject(error)
    })
    child.once("close", (exitCode) => {
      clearTimeout(timer)
      resolve({
        stdout: Buffer.concat(stdout).toString("utf8"),
        stderr: Buffer.concat(stderr).toString("utf8"),
        exitCode,
      })
    })
  })

/** Resolves with parsed evidence; rejects with VolumeSnapshotCollectorError on a nonzero exit or any stderr. */
export async function collectVolumeSnapshotEvidence(
  run: VolumeSnapshotRunner = runPowerShell,
  deadlineMs = VOLUME_SNAPSHOT_DEADLINE_MS,
  windowMinutes = EVENT_WINDOW_MINUTES,
): Promise<VolumeSnapshotEvidence> {
  const result = await run(
    ["-NoProfile", "-NonInteractive", "-Command", volumeSnapshotScript(windowMinutes)],
    deadlineMs,
  )
  const evidence = parseVolumeSnapshotOutput(result.stdout, windowMinutes)
  if (result.exitCode !== 0 || result.stderr.trim() !== "") throw new VolumeSnapshotCollectorError(result, evidence)
  return evidence
}

export interface EvidenceFiles {
  readonly write: (path: string, data: string) => Promise<void>
  readonly rename: (from: string, to: string) => Promise<void>
  readonly remove: (path: string) => Promise<void>
}

const realFiles: EvidenceFiles = {
  write: (path, data) => writeFile(path, data, { flag: "wx" }),
  rename: (from, to) => rename(from, to),
  remove: (path) => rm(path, { force: true }),
}

export interface PublishVolumeSnapshotOptions {
  readonly platform?: NodeJS.Platform
  readonly collect?: (deadlineMs: number) => Promise<VolumeSnapshotEvidence>
  readonly deadlineMs?: number
  readonly files?: EvidenceFiles
  readonly schedule?: (callback: () => void, delayMs: number) => () => void
}

export function volumeSnapshotEvidencePath(recordPath: string): string {
  return `${recordPath}.vss.json`
}

function failureEvidence(error: unknown): Record<string, unknown> {
  if (error instanceof VolumeSnapshotCollectorError)
    return { error: error.message, exitCode: error.exitCode, stderr: error.stderr, partial: error.partial }
  return { error: error instanceof Error ? error.message : String(error) }
}

/**
 * Publishes the volume snapshot evidence of a git timeout to `<record>.vss.json`, never touching the record itself.
 * Every publish writes a temp file and renames it into place, so the sibling is either absent or complete. The
 * collector's result (or its failure) is published only while the deadline has not passed; at the deadline a
 * timeout marker is published instead, and a later result is discarded with its temp file. Never rejects.
 */
export async function publishVolumeSnapshotEvidence(
  recordPath: string,
  options: PublishVolumeSnapshotOptions = {},
): Promise<void> {
  if ((options.platform ?? process.platform) !== "win32") return
  const deadlineMs = options.deadlineMs ?? VOLUME_SNAPSHOT_DEADLINE_MS
  const collect = options.collect ?? ((deadline: number) => collectVolumeSnapshotEvidence(runPowerShell, deadline))
  const files = options.files ?? realFiles
  const schedule =
    options.schedule ??
    ((callback: () => void, delayMs: number) => {
      const timer = setTimeout(callback, delayMs)
      return () => clearTimeout(timer)
    })
  const target = volumeSnapshotEvidencePath(recordPath)
  const startedAt = Date.now()
  // collecting -> publishing -> done, or collecting -> expired. Only the side that leaves `collecting` publishes,
  // and the check and the transition are one synchronous step, so the result and the timeout marker never race.
  const phase: { state: "collecting" | "publishing" | "expired" | "done" } = { state: "collecting" }
  const currentPhase = () => phase.state

  const publish = async (payload: Record<string, unknown>, claim: () => boolean): Promise<void> => {
    const temp = `${target}.tmp-${process.pid}-${randomUUID()}`
    try {
      await files.write(temp, `${JSON.stringify(payload, null, 2)}\n`)
      if (!claim()) return
      await files.rename(temp, target)
    } catch (error) {
      process.stderr.write(`volume snapshot evidence could not be published to ${target}: ${String(error)}\n`)
    } finally {
      await files.remove(temp).catch(() => undefined)
    }
  }

  const fromCollector = (async () => {
    let payload: Record<string, unknown>
    try {
      payload = { volumeShadowCopy: await collect(deadlineMs), collectedInMs: Date.now() - startedAt }
    } catch (error) {
      payload = failureEvidence(error)
    }
    if (phase.state !== "collecting") return
    await publish(payload, () => {
      if (phase.state !== "collecting") return false
      phase.state = "publishing"
      return true
    })
    if (currentPhase() === "publishing") phase.state = "done"
  })()

  const atDeadline = new Promise<void>((resolve) => {
    const cancel = schedule(() => {
      if (phase.state !== "collecting") return resolve()
      phase.state = "expired"
      void publish({ error: `not collected within ${deadlineMs} ms` }, () => true).then(resolve)
    }, deadlineMs)
    void fromCollector.then(() => {
      if (phase.state === "done" || phase.state === "collecting") {
        cancel()
        resolve()
      }
    })
  })

  await atDeadline
}
