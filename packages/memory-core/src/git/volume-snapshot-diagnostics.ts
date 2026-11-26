import { captureToFile, type DiagnosticCommandRunner } from "./diagnostic-capture"

// Windows CI attributed a stalled `git add` to a Volume Shadow Copy snapshot only by process start times: VSSVC.exe
// started in the same second as the git that then waited past its timeout. This records the snapshot evidence itself
// at the moment of the timeout: recent VSS / volsnap events, the VSSVC process, and the existing shadow copies.
const VOLUME_SNAPSHOT_TIMEOUT_MS = 10_000
const EVENT_WINDOW_MINUTES = 10
const EVENT_PROVIDERS = ["VSS", "VSSVC", "volsnap", "Microsoft-Windows-VolumeSnapshot-Driver"] as const

export const VOLUME_SNAPSHOT_SECTIONS = {
  events: "== volume snapshot events",
  process: "== VSSVC process",
  shadows: "== vssadmin list shadows",
} as const

export function volumeSnapshotScript(): string {
  const providers = EVENT_PROVIDERS.map((name) => `'${name}'`).join(",")
  return [
    `$since = (Get-Date).AddMinutes(-${EVENT_WINDOW_MINUTES})`,
    `"${VOLUME_SNAPSHOT_SECTIONS.events} (Application, System; since $($since.ToUniversalTime().ToString('o')))"`,
    // One query per provider: a provider that is not registered on this host must not hide the others. The time window is an
    // XPath timediff in milliseconds, which does not depend on the host's locale the way a StartTime DateTime does.
    `foreach ($provider in @(${providers})) { try { Get-WinEvent -LogName Application,System -FilterXPath "*[System[Provider[@Name='$provider'] and TimeCreated[timediff(@SystemTime) &lt;= ${EVENT_WINDOW_MINUTES * 60_000}]]]" -ErrorAction Stop | ForEach-Object { '{0} {1} {2} id={3} {4}: {5}' -f $_.TimeCreated.ToUniversalTime().ToString('o'), $_.LogName, $_.ProviderName, $_.Id, $_.LevelDisplayName, ($_.Message -replace '\\s+', ' ') } } catch { "$($provider): $($_.Exception.Message)" } }`,
    `"${VOLUME_SNAPSHOT_SECTIONS.process}"`,
    `Get-CimInstance Win32_Process -Filter "Name='VSSVC.exe'" | ForEach-Object { '{0} ppid={1} created={2}' -f $_.ProcessId, $_.ParentProcessId, $_.CreationDate.ToUniversalTime().ToString('o') }`,
    `"${VOLUME_SNAPSHOT_SECTIONS.shadows}"`,
    // vssadmin can start the VSS service itself, which would plant a VSSVC.exe start in the evidence of a later timeout;
    // it runs only when VSSVC is already running.
    `if (Get-Process VSSVC -ErrorAction SilentlyContinue) { vssadmin list shadows 2>&1 | Out-String -Width 400 } else { 'skipped: VSSVC is not running, and this diagnostic does not start it' }`,
  ].join("; ")
}

export function volumeSnapshotEvidence(
  platform: NodeJS.Platform = process.platform,
  run: DiagnosticCommandRunner = captureToFile,
): string | undefined {
  if (platform !== "win32") return undefined
  return run(
    "powershell",
    ["-NoProfile", "-NonInteractive", "-Command", volumeSnapshotScript()],
    VOLUME_SNAPSHOT_TIMEOUT_MS,
    "volume snapshot evidence",
  )
}
