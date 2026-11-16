param(
  [Parameter(Mandatory = $true)]
  [string]$ArtifactDirectory
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$collector = Join-Path $PSScriptRoot "windows-ci-telemetry.ps1"
$runner = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot "../../script/ci-windows-shard-1.ts"))
$root = Join-Path ([System.IO.Path]::GetTempPath()) ("telemetry-owner-" + [guid]::NewGuid().ToString("N"))
$orphans = [System.Collections.Generic.List[System.Diagnostics.Process]]::new()
$passed = 0
function Stop-OwnedOrphans {
  foreach ($owned in $orphans) {
    try {
      if (-not $owned.HasExited) { $owned.Kill($true) }
      $owned.WaitForExit()
      if (-not $owned.HasExited) { throw "Owned orphan did not terminate" }
      Write-Host "JOINED owned orphan $($owned.Id)"
    } finally {
      $owned.Dispose()
    }
  }
  $orphans.Clear()
}
$scenarios = foreach ($leak in @($true, $false)) {
  foreach ($failure in @($false, $true)) { @{ leak = $leak; failure = $failure } }
}
try {
  foreach ($legacy in @($false, $true)) {
    foreach ($scenario in $scenarios) {
      $leak = $scenario.leak
      $failure = $scenario.failure
      $case = "legacy-$legacy-leak-$leak-failure-$failure"
      $fixture = Join-Path $root $case
      $logs = Join-Path $fixture "logs"
      New-Item -ItemType Directory -Path $fixture -Force | Out-Null
      foreach ($target in @("omo-opencode", "memory-core")) {
        $directory = Join-Path $fixture "packages/$target"
        New-Item -ItemType Directory -Path $directory -Force | Out-Null
        $body = @'
import { test, expect } from "bun:test";
import { writeFileSync } from "node:fs";
import { spawn } from "node:child_process";
test("actual package", () => {
  if (LEAK) {
    const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"],
      { stdio: "ignore", detached: true });
    writeFileSync("orphan.json", JSON.stringify({ pid: child.pid, parentPid: process.pid }));
    child.unref();
  }
  expect(FAILURE).toBe(false);
});
'@
        $body = $body.Replace("LEAK", ($leak -and $target -eq "omo-opencode").ToString().ToLowerInvariant())
        $body = $body.Replace("FAILURE", ($failure -and $target -eq "omo-opencode").ToString().ToLowerInvariant())
        Set-Content -Path (Join-Path $directory "actual.test.ts") -Value $body -Encoding utf8NoBOM
      }
      $drive = Join-Path $fixture "drive.ps1"
      $arguments = if ($legacy) { "'test', 'packages/omo-opencode'" } else { "'$runner', '$logs'" }
      "& '$collector' -ArtifactDirectory '$logs' -Invocation 'owner' -TestArguments @($arguments)`nexit `$LASTEXITCODE" |
        Set-Content -Path $drive -Encoding utf8NoBOM
      Push-Location $fixture
      try {
        & pwsh -NoProfile -File $drive
        $actualExit = $LASTEXITCODE
      } finally {
        Pop-Location
        $orphanPath = Join-Path $fixture "orphan.json"
        if (Test-Path -LiteralPath $orphanPath) {
          $identity = Get-Content -LiteralPath $orphanPath -Raw | ConvertFrom-Json
          $owned = [System.Diagnostics.Process]::GetProcessById([int]$identity.pid)
          $orphans.Add($owned)
        } elseif ($leak) { throw "$case did not create its orphan" }
        $caseArtifacts = Join-Path $ArtifactDirectory $case
        New-Item -ItemType Directory -Path $caseArtifacts -Force | Out-Null
        if (Test-Path -LiteralPath $logs) {
          Copy-Item -LiteralPath $logs -Destination $caseArtifacts -Recurse -Force
        }
        if (Test-Path -LiteralPath $orphanPath) {
          Copy-Item -LiteralPath $orphanPath -Destination $caseArtifacts -Force
        }
      }
      $expectedExit = if ($failure) { 1 } else { 0 }
      $capture = Get-Content -LiteralPath (Join-Path $logs "owner.json") -Raw | ConvertFrom-Json
      if (@($capture.telemetryErrors).Count -ne 0) { throw "$case had a telemetry error" }
      if ($actualExit -ne $expectedExit -or $capture.testExitCode -ne $expectedExit) {
        throw "$case lost the actual test exit code"
      }
      if ($leak) {
        if ($null -ne (Get-Process -Id $identity.parentPid -ErrorAction SilentlyContinue)) {
          throw "$case kept the package parent alive"
        }
        $survivors = @($capture.survivingDescendants)
        if ($survivors.Count -ne 1 -or $survivors[0].pid -ne $identity.pid -or
            $survivors[0].parentPid -ne $identity.parentPid) {
          throw "$case lost the exact owned orphan after its package parent exited"
        }
      } elseif (@($capture.survivingDescendants).Count -ne 0) {
        throw "$case reported a survivor without a leak"
      }
      $expectedRoots = if ($legacy) { 0 } else { 2 }
      if (@($capture.packageRoots).Count -ne $expectedRoots) { throw "$case lost package-root receipts" }
      $passed++
      Write-Host "PASS $case"
      Stop-OwnedOrphans
    }
  }
  foreach ($mode in @("valid", "stale", "foreign", "invalid-lifetime", "before-birth", "after-birth")) {
    $fixture = Join-Path $root $mode
    $logs = Join-Path $fixture "logs"
    New-Item -ItemType Directory -Path $fixture -Force | Out-Null
    @'
import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";
const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore", detached: true });
writeFileSync("orphan.json", JSON.stringify({ pid: child.pid, parentPid: process.pid }));
child.unref();
'@ | Set-Content -Path (Join-Path $fixture "parent.ts") -Encoding utf8NoBOM
    $probe = @'
import { writeFileSync } from "node:fs";
const mode = "MODE";
const started = Date.now();
const parent = Bun.spawn([process.execPath, "parent.ts"], { stdin: "ignore", stdout: "ignore", stderr: "ignore" });
await parent.exited;
const ended = Date.now() + 1;
const start = mode === "invalid-lifetime" || mode === "after-birth" ? ended : started;
const end = mode === "invalid-lifetime" || mode === "before-birth" ? started : ended;
writeFileSync(process.env.OMO_CI_PACKAGE_ROOTS_PATH!, JSON.stringify({
  schemaVersion: 1,
  captureId: mode === "stale" ? "previous-invocation" : process.env.OMO_CI_PACKAGE_ROOTS_CAPTURE_ID,
  ownerPid: mode === "foreign" ? process.pid + 1 : process.pid,
  roots: [{ pid: parent.pid, startedUtc: new Date(start).toISOString(), exitedUtc: new Date(end).toISOString() }]
}));
process.exitCode = 7;
'@
    $probe.Replace("MODE", $mode) | Set-Content -Path (Join-Path $fixture "probe.ts") -Encoding utf8NoBOM
    $drive = Join-Path $fixture "drive.ps1"
    "& '$collector' -ArtifactDirectory '$logs' -Invocation 'owner' -TestArguments @('probe.ts')`nexit `$LASTEXITCODE" |
      Set-Content -Path $drive -Encoding utf8NoBOM
    Push-Location $fixture
    try {
      & pwsh -NoProfile -File $drive
      $actualExit = $LASTEXITCODE
    } finally {
      Pop-Location
      $orphanPath = Join-Path $fixture "orphan.json"
      $identity = Get-Content -LiteralPath $orphanPath -Raw | ConvertFrom-Json
      $orphans.Add([System.Diagnostics.Process]::GetProcessById([int]$identity.pid))
      $caseArtifacts = Join-Path $ArtifactDirectory $mode
      New-Item -ItemType Directory -Path $caseArtifacts -Force | Out-Null
      Copy-Item -LiteralPath $logs -Destination $caseArtifacts -Recurse -Force
      Copy-Item -LiteralPath $orphanPath -Destination $caseArtifacts -Force
    }
    $capture = Get-Content -LiteralPath (Join-Path $logs "owner.json") -Raw | ConvertFrom-Json
    if ($actualExit -ne 7 -or $capture.testExitCode -ne 7) { throw "$mode hid the probe exit code" }
    $survivors = @($capture.survivingDescendants)
    $expectedSurvivors = if ($mode -eq "valid") { 1 } else { 0 }
    if ($survivors.Count -ne $expectedSurvivors -or
        ($mode -eq "valid" -and $survivors[0].pid -ne $identity.pid)) {
      throw "$mode did not fence orphan ancestry"
    }
    $invalid = $mode -in @("stale", "foreign", "invalid-lifetime")
    $errors = @($capture.telemetryErrors | Where-Object { $_.stage -eq "package root receipt" })
    if ($errors.Count -ne [int]$invalid) { throw "$mode changed nonfatal receipt validation" }
    $passed++
    Write-Host "PASS receipt-$mode"
    Stop-OwnedOrphans
  }
  Write-Host "$passed telemetry owner cases passed"
} finally {
  Stop-OwnedOrphans
  if (Test-Path -LiteralPath $root) { Remove-Item -LiteralPath $root -Recurse -Force }
}
