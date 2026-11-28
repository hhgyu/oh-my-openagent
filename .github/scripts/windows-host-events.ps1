param(
  [Parameter(Mandatory = $true)]
  [ValidateNotNullOrEmpty()]
  [string]$ArtifactDirectory,

  [Parameter(Mandatory = $true)]
  [ValidatePattern("^[a-z0-9-]+$")]
  [string]$Invocation
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

# Host-wide evidence for the Windows test timeouts that stall every package process at once
# (.omo/reports/windows-shard1-timeouts-20261128.md): a Volume Shadow Copy snapshot started in the same
# second as each stalled git that was ever recorded, about 11 minutes after boot. This dump names the
# boot time, the VSS processes and services, every VSS/volsnap event since boot and the scheduled tasks
# that ran, so each run carries the timeline whether or not a test timed out. Read-only: it never starts
# the VSS service. Collection failures are recorded in the payload, never thrown.

$MaxEventsPerQuery = 400
$MaxMessageLength = 600
$collectionErrors = [System.Collections.Generic.List[object]]::new()

function ConvertTo-UtcText {
  param($Value)
  if ($null -eq $Value) { return $null }
  return ([datetime]$Value).ToUniversalTime().ToString("o")
}

function Add-CollectionError {
  param([string]$Stage, [System.Management.Automation.ErrorRecord]$Record)
  $collectionErrors.Add([ordered]@{ stage = $Stage; error = "$($Record.Exception.Message)" })
}

function Get-EventRecords {
  # XPath rather than -FilterHashtable: the hashtable's StartTime round-trips through the current culture and
  # fails on non-English hosts, and one unregistered provider in it fails the whole query.
  param([string]$Stage, [string]$LogName, [string]$Condition)
  $xpath = "*[System[TimeCreated[@SystemTime>='$sinceXPath']$(if ($Condition) { " and $Condition" })]]"
  try {
    $found = Get-WinEvent -LogName $LogName -FilterXPath $xpath -MaxEvents $MaxEventsPerQuery -ErrorAction Stop
  } catch {
    # "No events were found" is an answer, not a failure.
    if ($_.FullyQualifiedErrorId -like "NoMatchingEventsFound*") { return }
    Add-CollectionError -Stage $Stage -Record $_
    return
  }
  return @(
    $found | Sort-Object TimeCreated | ForEach-Object {
      $message = "$($_.Message)" -replace "\s+", " "
      if ($message.Length -gt $MaxMessageLength) { $message = $message.Substring(0, $MaxMessageLength) }
      [ordered]@{
        timeUtc = ConvertTo-UtcText $_.TimeCreated
        log = $_.LogName
        provider = $_.ProviderName
        id = $_.Id
        level = "$($_.LevelDisplayName)"
        processId = $_.ProcessId
        message = $message
      }
    }
  )
}

function Get-ProcessStarts {
  param([string]$Stage, [string]$Filter)
  try {
    return @(
      Get-CimInstance Win32_Process -Filter $Filter -ErrorAction Stop | ForEach-Object {
        [ordered]@{
          pid = $_.ProcessId
          parentPid = $_.ParentProcessId
          name = $_.Name
          createdUtc = ConvertTo-UtcText $_.CreationDate
          commandLine = $_.CommandLine
        }
      }
    )
  } catch {
    Add-CollectionError -Stage $Stage -Record $_
    return @()
  }
}

$bootUtc = $null
try {
  $bootUtc = (Get-CimInstance Win32_OperatingSystem -ErrorAction Stop).LastBootUpTime
} catch {
  Add-CollectionError -Stage "boot" -Record $_
}
$since = if ($null -ne $bootUtc) { [datetime]$bootUtc } else { (Get-Date).AddHours(-6) }
$sinceXPath = $since.ToUniversalTime().ToString("yyyy-MM-ddTHH:mm:ss.fffZ", [System.Globalization.CultureInfo]::InvariantCulture)

$services = @(
  foreach ($name in @("VSS", "swprv")) {
    try {
      $service = Get-CimInstance Win32_Service -Filter "Name='$name'" -ErrorAction Stop
      if ($null -eq $service) { continue }
      $hostProcess = $null
      if ($service.ProcessId -gt 0) {
        $hostProcess = Get-ProcessStarts -Stage "service-$name-process" -Filter "ProcessId=$($service.ProcessId)" | Select-Object -First 1
      }
      [ordered]@{
        name = $service.Name
        displayName = $service.DisplayName
        state = $service.State
        startMode = $service.StartMode
        pid = $service.ProcessId
        processCreatedUtc = if ($null -ne $hostProcess) { $hostProcess.createdUtc } else { $null }
      }
    } catch {
      Add-CollectionError -Stage "service-$name" -Record $_
    }
  }
)

$volumes = @(
  foreach ($path in @($env:SystemDrive, $env:TEMP, $env:RUNNER_TEMP, $env:GITHUB_WORKSPACE)) {
    if ([string]::IsNullOrWhiteSpace($path)) { continue }
    try {
      $letter = ([System.IO.Path]::GetPathRoot([System.IO.Path]::GetFullPath($path + "\"))).Substring(0, 1)
      $volume = Get-Volume -DriveLetter $letter -ErrorAction Stop
      # uniqueId carries the volume GUID that the snapshot driver's events name.
      [ordered]@{
        path = $path
        driveLetter = $letter
        fileSystem = $volume.FileSystem
        label = $volume.FileSystemLabel
        uniqueId = $volume.UniqueId
      }
    } catch {
      Add-CollectionError -Stage "volume" -Record $_
    }
  }
)

$snapshotProviders = @("VSS", "VSSVC", "volsnap", "Microsoft-Windows-VolumeSnapshot-Driver")
$payload = [ordered]@{
  schemaVersion = 1
  invocation = $Invocation
  collectedUtc = ConvertTo-UtcText (Get-Date)
  bootUtc = ConvertTo-UtcText $bootUtc
  correlation = [ordered]@{ runId = $env:GITHUB_RUN_ID; runAttempt = $env:GITHUB_RUN_ATTEMPT; job = $env:GITHUB_JOB }
  temporaryPaths = [ordered]@{ temp = $env:TEMP; tmp = $env:TMP; runnerTemp = $env:RUNNER_TEMP }
  volumes = $volumes
  vssProcesses = @(Get-ProcessStarts -Stage "vssvc" -Filter "Name='VSSVC.exe'")
  services = $services
  snapshotEvents = @(
    foreach ($log in @("Application", "System")) {
      # Providers that are not registered on this image simply match nothing.
      Get-EventRecords -Stage "snapshot-$log" -LogName $log -Condition (
        "(" + (($snapshotProviders | ForEach-Object { "Provider[@Name='$_']" }) -join " or ") + ")"
      )
    }
  )
  snapshotDriverOperational = @(
    Get-EventRecords -Stage "snapshot-driver-operational" -LogName "Microsoft-Windows-VolumeSnapshot-Driver/Operational"
  )
  # 7036 (entered running/stopped state) and 7040 (start type changed) name the VSS and swprv services.
  serviceStateChanges = @(
    if ($services.Count -gt 0) {
      # param1 is the localized display name, so it is matched against the names this host reports.
      $names = ($services | ForEach-Object { "Data[@Name='param1']='$($_.displayName)'" }) -join " or "
      $xpath = "*[System[Provider[@Name='Service Control Manager'] and (EventID=7036 or EventID=7040) and " +
        "TimeCreated[@SystemTime>='$sinceXPath']] and EventData[$names]]"
      try {
        Get-WinEvent -LogName System -FilterXPath $xpath -MaxEvents $MaxEventsPerQuery -ErrorAction Stop |
          Sort-Object TimeCreated |
          ForEach-Object { [ordered]@{ timeUtc = ConvertTo-UtcText $_.TimeCreated; id = $_.Id; message = "$($_.Message)" } }
      } catch {
        if ($_.FullyQualifiedErrorId -notlike "NoMatchingEventsFound*") { Add-CollectionError -Stage "service-control-manager" -Record $_ }
      }
    }
  )
  # Disabled by default on Windows Server; the job enables it at its start, so tasks after that are listed.
  scheduledTasks = @(
    Get-EventRecords -Stage "task-scheduler" -LogName "Microsoft-Windows-TaskScheduler/Operational" -Condition (
      "(" + ((@(100, 102, 106, 107, 110, 129, 200, 201) | ForEach-Object { "EventID=$_" }) -join " or ") + ")"
    )
  )
  collectionErrors = $collectionErrors
}

New-Item -ItemType Directory -Force -Path $ArtifactDirectory | Out-Null
$artifactPath = Join-Path $ArtifactDirectory "$Invocation.json"
$payload | ConvertTo-Json -Depth 6 | Set-Content -Path $artifactPath -Encoding utf8NoBOM

$vssvcStarts = @($payload.vssProcesses | ForEach-Object { $_.createdUtc }) -join ", "
$snapshotsCreated = @($payload.snapshotDriverOperational | Where-Object { $_.id -eq 126 } | ForEach-Object { $_.timeUtc }) -join ", "
"host events: boot $($payload.bootUtc); VSSVC started: [$vssvcStarts]; shadow copies created: [$snapshotsCreated]; " +
"$($payload.snapshotEvents.Count) VSS/volsnap events, $($payload.scheduledTasks.Count) task scheduler events, " +
"$($collectionErrors.Count) collection errors; written to $artifactPath"
