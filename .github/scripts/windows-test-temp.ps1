Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

# Windows shard 1 timed out on varied tests that all stalled in the same minutes, and the only stalled gits ever
# recorded started in the same second as a Volume Shadow Copy snapshot of the OS volume, where every temp file
# lived. Every test temp root follows os.tmpdir() (test-temp-root.ts), so TEMP/TMP/TMPDIR under RUNNER_TEMP move
# the rest of the job's temp files to the runner's local D: disk, beside the checkout.
$testTemp = Join-Path $env:RUNNER_TEMP "test-tmp"
New-Item -ItemType Directory -Force -Path $testTemp | Out-Null
if ([System.IO.Path]::GetPathRoot($testTemp) -eq [System.IO.Path]::GetPathRoot("$env:SystemDrive\")) {
  "::warning::RUNNER_TEMP ($env:RUNNER_TEMP) is on the system drive; temp files stay on the OS volume"
}
foreach ($name in @("TEMP", "TMP", "TMPDIR")) { "$name=$testTemp" >> $env:GITHUB_ENV }
"temp root for the rest of the job: $testTemp"
