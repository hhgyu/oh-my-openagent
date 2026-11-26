import { spawn } from "node:child_process"
import { readFile, writeFile } from "../fs/resilient"

// Windows CI attributed a stalled `git add` to a Volume Shadow Copy snapshot only by process start times: VSSVC.exe
// started in the same second as the git that then waited past its timeout. The timeout's record therefore carries
// the snapshot evidence itself, collected after the git is signalled: recent VSS / volsnap events and the VSSVC
// process. Only the event log and the process table are read, so the VSS service is never started.
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

/** Runs the collector command and resolves with its stdout; it must settle by the given deadline. */
export type VolumeSnapshotRunner = (args: readonly string[], deadlineMs: number) => Promise<string>

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

function parseVolumeSnapshotOutput(output: string, windowMinutes = EVENT_WINDOW_MINUTES): VolumeSnapshotEvidence {
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
    const chunks: Buffer[] = []
    let bytes = 0
    const timer = setTimeout(() => {
      child.kill()
      reject(new Error(`volume snapshot collector did not finish within ${deadlineMs} ms`))
    }, deadlineMs)
    child.stdout.on("data", (chunk: Buffer) => {
      if (bytes < MAX_OUTPUT_BYTES) chunks.push(chunk)
      bytes += chunk.length
    })
    child.stderr.resume()
    child.once("error", (error) => {
      clearTimeout(timer)
      reject(error)
    })
    child.once("close", () => {
      clearTimeout(timer)
      resolve(Buffer.concat(chunks).toString("utf8"))
    })
  })

export async function collectVolumeSnapshotEvidence(
  run: VolumeSnapshotRunner = runPowerShell,
  deadlineMs = VOLUME_SNAPSHOT_DEADLINE_MS,
  windowMinutes = EVENT_WINDOW_MINUTES,
): Promise<VolumeSnapshotEvidence> {
  const output = await run(
    ["-NoProfile", "-NonInteractive", "-Command", volumeSnapshotScript(windowMinutes)],
    deadlineMs,
  )
  return parseVolumeSnapshotOutput(output, windowMinutes)
}

export interface AppendVolumeSnapshotOptions {
  readonly platform?: NodeJS.Platform
  readonly collect?: (deadlineMs: number) => Promise<VolumeSnapshotEvidence>
  readonly deadlineMs?: number
}

/**
 * Adds `volumeShadowCopy` (or `volumeShadowCopyError`) to a git timeout record that is already on disk. One
 * deadline covers the collection and the record update; a late collection never writes. Never rejects, and the
 * record's existing fields, the process snapshot among them, are kept whatever the collector does.
 */
export async function appendVolumeSnapshotEvidence(
  recordPath: string,
  options: AppendVolumeSnapshotOptions = {},
): Promise<void> {
  if ((options.platform ?? process.platform) !== "win32") return
  const deadlineMs = options.deadlineMs ?? VOLUME_SNAPSHOT_DEADLINE_MS
  const collect = options.collect ?? ((deadline: number) => collectVolumeSnapshotEvidence(runPowerShell, deadline))
  const startedAt = Date.now()
  let expired = false
  const update = async (field: Record<string, unknown>): Promise<void> => {
    if (expired) return
    const record = JSON.parse(await readFile(recordPath, "utf8")) as Record<string, unknown>
    if (expired) return
    await writeFile(recordPath, `${JSON.stringify({ ...record, ...field }, null, 2)}\n`)
  }
  const work = (async () => {
    try {
      const evidence = await collect(deadlineMs)
      await update({ volumeShadowCopy: { ...evidence, collectedInMs: Date.now() - startedAt } })
    } catch (error) {
      await update({ volumeShadowCopyError: error instanceof Error ? error.message : String(error) })
    }
  })()
  let timer: ReturnType<typeof setTimeout> | undefined
  const deadline = new Promise<"expired">((resolve) => {
    timer = setTimeout(() => resolve("expired"), deadlineMs)
  })
  try {
    const outcome = await Promise.race([work.then(() => "done" as const), deadline])
    if (outcome === "expired") {
      expired = true
      const record = JSON.parse(await readFile(recordPath, "utf8")) as Record<string, unknown>
      await writeFile(
        recordPath,
        `${JSON.stringify({ ...record, volumeShadowCopyError: `not collected within ${deadlineMs} ms` }, null, 2)}\n`,
      )
    }
  } catch (error) {
    process.stderr.write(`volume snapshot evidence could not be added to ${recordPath}: ${String(error)}\n`)
  } finally {
    clearTimeout(timer)
  }
}
