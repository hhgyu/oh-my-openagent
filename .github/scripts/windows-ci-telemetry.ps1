param(
  [Parameter(Mandatory = $true)]
  [ValidateNotNullOrEmpty()]
  [string]$ArtifactDirectory,

  [Parameter(Mandatory = $true)]
  [ValidatePattern("^[a-z0-9-]+$")]
  [string]$Invocation,

  [Parameter(Mandatory = $true)]
  [ValidateNotNullOrEmpty()]
  [string[]]$TestArguments
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

# Bun applies a preload's setDefaultTimeout only to the first test file of a sequential run;
# every later file falls back to the built-in 5000ms (reproduced on bun 1.4.0/1.4.1, all OSes).
# Only the CLI flag reaches every file, so pin the Windows budget here for every job that
# goes through this wrapper. Keep in step with test-setup.ts.
$WindowsTestTimeoutMs = "30000"
if (($TestArguments -contains "test") -and -not ($TestArguments -contains "--timeout")) {
  $withTimeout = @()
  foreach ($argument in $TestArguments) {
    $withTimeout += $argument
    if ($argument -eq "test") { $withTimeout += @("--timeout", $WindowsTestTimeoutMs) }
  }
  $TestArguments = $withTimeout
}

$telemetryErrors = [System.Collections.Generic.List[object]]::new()

function Add-TelemetryError {
  param(
    [Parameter(Mandatory = $true)]
    [string]$Stage,

    [Parameter(Mandatory = $true)]
    [System.Exception]$Exception
  )

  $telemetryErrors.Add([ordered]@{
      stage = $Stage
      errorType = $Exception.GetType().FullName
    })
  Write-Warning "Windows CI telemetry capture failed during $Stage; test execution continues."
}

function ConvertTo-ProcessRecord {
  param(
    [Parameter(Mandatory = $true)]
    [Microsoft.Management.Infrastructure.CimInstance]$Process
  )

  $creationTimeUtc = if ($null -eq $Process.CreationDate) {
    $null
  } else {
    $Process.CreationDate.ToUniversalTime().ToString("o")
  }

  return [ordered]@{
    name = [string]$Process.Name
    pid = [uint32]$Process.ProcessId
    parentPid = [uint32]$Process.ParentProcessId
    creationTimeUtc = $creationTimeUtc
  }
}

function Get-ProcessRecord {
  param(
    [Parameter(Mandatory = $true)]
    [uint32]$ProcessId
  )

  $process = Get-CimInstance `
    -ClassName Win32_Process `
    -Filter "ProcessId = $ProcessId" `
    -OperationTimeoutSec 5
  if ($null -eq $process) {
    return $null
  }
  return ConvertTo-ProcessRecord -Process $process
}

function Get-SurvivingDescendants {
  param(
    [Parameter(Mandatory = $true)]
    [uint32]$RootProcessId,

    [object[]]$RecordedRoots = @()
  )

  $processes = @(Get-CimInstance -ClassName Win32_Process -OperationTimeoutSec 5)
  $descendantIds = [System.Collections.Generic.HashSet[uint32]]::new()
  $pendingParents = [System.Collections.Generic.Queue[object]]::new()
  $pendingParents.Enqueue(@{ pid = $RootProcessId; startedUtc = $null; exitedUtc = $null })
  foreach ($root in $RecordedRoots) { $pendingParents.Enqueue($root) }

  while ($pendingParents.Count -gt 0) {
    $parent = $pendingParents.Dequeue()
    foreach ($process in $processes) {
      if ([uint32]$process.ParentProcessId -ne $parent.pid) {
        continue
      }
      if ($null -ne $parent.startedUtc) {
        # A matching numeric PID alone is insufficient after a package exits.
        # Only children born during that owned parent's lifetime belong to it.
        if ($null -eq $process.CreationDate) { continue }
        $created = $process.CreationDate.ToUniversalTime()
        if ($created -lt $parent.startedUtc -or
            ($null -ne $parent.exitedUtc -and $created -gt $parent.exitedUtc)) { continue }
      }
      $processId = [uint32]$process.ProcessId
      if ($descendantIds.Add($processId)) {
        $pendingParents.Enqueue(@{
          pid = $processId
          startedUtc = if ($null -ne $process.CreationDate) { $process.CreationDate.ToUniversalTime() } else { $null }
          exitedUtc = $null
        })
      }
    }
  }

  return @(
    $processes |
      Where-Object { $descendantIds.Contains([uint32]$_.ProcessId) } |
      ForEach-Object { ConvertTo-ProcessRecord -Process $_ }
  )
}

$preTestUtc = [DateTime]::UtcNow.ToString("o")
$preTestStopwatchTimestamp = [System.Diagnostics.Stopwatch]::GetTimestamp()
$telemetryProcess = $null
try {
  $telemetryProcess = Get-ProcessRecord -ProcessId ([uint32]$PID)
} catch {
  Add-TelemetryError -Stage "pre-test process capture" -Exception $_.Exception
}

$testExitCode = 1
$testProcess = $null
$testProcessRecord = $null
$testLaunchErrorType = $null
$packageRootsPath = $null
$captureId = [guid]::NewGuid().ToString("N")
try {
  New-Item -ItemType Directory -Path $ArtifactDirectory -Force | Out-Null
  $packageRootsPath = Join-Path $ArtifactDirectory "package-roots-$captureId.json"
} catch {
  Add-TelemetryError -Stage "package root receipt setup" -Exception $_.Exception
}
$previousRootsPath = $env:OMO_CI_PACKAGE_ROOTS_PATH
$previousCaptureId = $env:OMO_CI_PACKAGE_ROOTS_CAPTURE_ID
try {
  try {
    $env:OMO_CI_PACKAGE_ROOTS_PATH = $packageRootsPath
    $env:OMO_CI_PACKAGE_ROOTS_CAPTURE_ID = if ($null -ne $packageRootsPath) { $captureId } else { $null }
    $testProcess = Start-Process `
      -FilePath "bun" `
      -ArgumentList $TestArguments `
      -NoNewWindow `
      -PassThru
  } finally {
    $env:OMO_CI_PACKAGE_ROOTS_PATH = $previousRootsPath
    $env:OMO_CI_PACKAGE_ROOTS_CAPTURE_ID = $previousCaptureId
  }
  try {
    $testProcessRecord = Get-ProcessRecord -ProcessId ([uint32]$testProcess.Id)
  } catch {
    Add-TelemetryError -Stage "test process capture" -Exception $_.Exception
  }
  $testProcess.WaitForExit()
  $testExitCode = $testProcess.ExitCode
} catch {
  $testLaunchErrorType = $_.Exception.GetType().FullName
  Write-Error "Windows root-test process failed to start or wait." -ErrorAction Continue
}

$postTestUtc = [DateTime]::UtcNow.ToString("o")
$postTestStopwatchTimestamp = [System.Diagnostics.Stopwatch]::GetTimestamp()
$survivingDescendants = @()
$packageRoots = @()
if ($null -ne $testProcess) {
  if ($null -ne $packageRootsPath -and (Test-Path -LiteralPath $packageRootsPath)) {
    try {
      $receipt = Get-Content -LiteralPath $packageRootsPath -Raw | ConvertFrom-Json
      if ($receipt.schemaVersion -ne 1 -or $receipt.captureId -cne $captureId -or
          $receipt.ownerPid -ne $testProcess.Id) { throw "Unowned package root receipt" }
      $validatedRoots = @(
        foreach ($root in $receipt.roots) {
          $started = ([DateTimeOffset]$root.startedUtc).UtcDateTime
          $exited = ([DateTimeOffset]$root.exitedUtc).UtcDateTime
          $rootPid = [uint32]$root.pid
          if ($rootPid -eq 0 -or $rootPid -eq $testProcess.Id -or $started -gt $exited -or
              $started -lt [DateTimeOffset]::Parse($preTestUtc).UtcDateTime -or
              $exited -gt [DateTimeOffset]::Parse($postTestUtc).UtcDateTime) {
            throw "Invalid package root lifetime"
          }
          @{ pid = $rootPid; startedUtc = $started; exitedUtc = $exited }
        }
      )
      $packageRoots = $validatedRoots
    } catch {
      Add-TelemetryError -Stage "package root receipt" -Exception $_.Exception
    }
  }
  try {
    $survivingDescendants = @(Get-SurvivingDescendants -RootProcessId ([uint32]$testProcess.Id) -RecordedRoots $packageRoots)
  } catch {
    Add-TelemetryError -Stage "post-test descendant capture" -Exception $_.Exception
  }
}

$payload = [ordered]@{
  schemaVersion = 1
  correlation = [ordered]@{
    runId = $env:GITHUB_RUN_ID
    runAttempt = $env:GITHUB_RUN_ATTEMPT
    job = $env:GITHUB_JOB
    shard = $env:WINDOWS_TEST_SHARD
    invocation = $Invocation
  }
  timing = [ordered]@{
    stopwatchFrequency = [string][System.Diagnostics.Stopwatch]::Frequency
    preTest = [ordered]@{
      utc = $preTestUtc
      stopwatchTimestamp = [string]$preTestStopwatchTimestamp
    }
    postTest = [ordered]@{
      utc = $postTestUtc
      stopwatchTimestamp = [string]$postTestStopwatchTimestamp
    }
  }
  temporaryPaths = [ordered]@{
    runnerTemp = $env:RUNNER_TEMP
    processTemp = [System.IO.Path]::GetTempPath()
    temp = $env:TEMP
    tmp = $env:TMP
  }
  telemetryProcess = $telemetryProcess
  testProcess = $testProcessRecord
  testExitCode = $testExitCode
  testLaunchErrorType = $testLaunchErrorType
  packageRoots = $packageRoots
  survivingDescendants = $survivingDescendants
  telemetryErrors = @($telemetryErrors)
}

try {
  New-Item -ItemType Directory -Path $ArtifactDirectory -Force | Out-Null
  $artifactPath = Join-Path $ArtifactDirectory "$Invocation.json"
  $payload | ConvertTo-Json -Depth 8 | Set-Content -Path $artifactPath -Encoding utf8NoBOM
} catch {
  Add-TelemetryError -Stage "artifact write" -Exception $_.Exception
}

exit $testExitCode
