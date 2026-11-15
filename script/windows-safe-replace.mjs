import { spawnSync } from "node:child_process"
import { randomBytes } from "node:crypto"
import { chmod, mkdir, readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises"
import { basename, dirname, join } from "node:path"

// A running OpenCode or Senpi that loaded this checkout keeps build outputs open. Windows then
// refuses to touch them: a handle without FILE_SHARE_WRITE/DELETE gives a sharing violation
// (EBUSY) or an access error (EPERM, EACCES), a delete that is still pending leaves its directory
// non-empty (ENOTEMPTY), and a file Bun memory-mapped while loading it fails a truncating open with
// ERROR_USER_MAPPED_FILE, which libuv reports as UNKNOWN. Renaming a finished temp file over a
// mapped file still works, so outputs are written beside the target and renamed into place. The
// codes are only treated as transient on Windows, where a short-lived handle (an editor save, an
// antivirus scan) commonly causes them; elsewhere they are real errors and surface at once.
const TRANSIENT_WINDOWS_CODES = new Set(["EBUSY", "EPERM", "EACCES", "ENOTEMPTY", "UNKNOWN"])
const DEFAULT_RETRY_DELAYS_MS = [50, 100, 200, 400, 800, 1000, 1000, 1000]
const LOCKER_PROBE_FILE_LIMIT = 256

export function isTransientWindowsLockError(error, platform = process.platform) {
  return (
    platform === "win32" &&
    error instanceof Error &&
    "code" in error &&
    typeof error.code === "string" &&
    TRANSIENT_WINDOWS_CODES.has(error.code)
  )
}

export class LockedOutputError extends Error {
  constructor(path, cause, attempts, waitedMs, lockers) {
    const code = cause instanceof Error && "code" in cause ? String(cause.code) : "unknown"
    const heldBy =
      lockers === undefined
        ? "the holding process could not be identified"
        : lockers.length === 0
          ? "no process reported holding it (the handle may have closed after the last attempt)"
          : `held by ${lockers.join(", ")}`
    super(
      `Cannot update build output ${path} (${code}) after ${attempts} attempts over ${waitedMs} ms; ${heldBy}. ` +
        "Close that process (a running OpenCode or Senpi that loaded this checkout keeps its bundles and skills open) " +
        "and rerun the build. The output was not updated.",
      { cause },
    )
    this.name = "LockedOutputError"
    this.path = path
    this.lockers = lockers
  }
}

async function withLockRetry(path, operation, options = {}) {
  const platform = options.platform ?? process.platform
  const delays = options.retryDelaysMs ?? DEFAULT_RETRY_DELAYS_MS
  const sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)))
  let waitedMs = 0
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await operation()
    } catch (error) {
      if (!isTransientWindowsLockError(error, platform)) throw error
      const delay = delays[attempt - 1]
      if (delay === undefined) {
        const describe = options.describeLockers ?? describeWindowsLockers
        throw new LockedOutputError(path, error, attempt, waitedMs, await describe(path))
      }
      await sleep(delay)
      waitedMs += delay
    }
  }
}

/**
 * Writes contents to target unless it already holds exactly those bytes (and mode, off Windows),
 * through a sibling temp file renamed into place. Returns whether the file changed.
 */
export async function replaceFileContents(target, contents, options = {}) {
  const bytes = Buffer.from(contents)
  const current = await withLockRetry(target, () => readCurrent(target), options)
  if (current?.kind === "directory") await removePath(target, options)
  const modeMatches = options.mode === undefined || process.platform === "win32" || current?.mode === options.mode
  if (current?.kind === "file" && modeMatches && current.bytes.equals(bytes)) return false
  await mkdir(dirname(target), { recursive: true })
  const temp = join(dirname(target), `.${basename(target)}.${process.pid}-${randomBytes(4).toString("hex")}.tmp`)
  try {
    await writeFile(temp, bytes)
    if (options.mode !== undefined) await chmod(temp, options.mode)
    await withLockRetry(target, () => (options.rename ?? rename)(temp, target), options)
  } finally {
    await rm(temp, { force: true })
  }
  return true
}

export async function removePath(target, options = {}) {
  await withLockRetry(target, () => (options.remove ?? rm)(target, { recursive: true, force: true }), options)
}

async function readCurrent(target) {
  let info
  try {
    info = await stat(target)
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return undefined
    throw error
  }
  if (info.isDirectory()) return { kind: "directory" }
  return { kind: "file", mode: info.mode & 0o777, bytes: await readFile(target) }
}

/** Names the processes holding path (or any file under it) through the Windows Restart Manager. */
async function describeWindowsLockers(path, platform = process.platform) {
  if (platform !== "win32") return undefined
  const files = await probeFiles(path)
  if (files.length === 0) return undefined
  const result = spawnSync(
    "powershell.exe",
    ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", RESTART_MANAGER_PROBE],
    { input: JSON.stringify(files), encoding: "utf8", timeout: 60_000, windowsHide: true },
  )
  if (result.error !== undefined || result.status !== 0) return undefined
  const parsed = JSON.parse(result.stdout.trim() || "[]")
  return Array.isArray(parsed) ? parsed.filter((entry) => typeof entry === "string") : undefined
}

async function probeFiles(path) {
  const found = []
  const visit = async (current) => {
    if (found.length >= LOCKER_PROBE_FILE_LIMIT) return
    const info = await stat(current).catch(() => undefined)
    if (info === undefined) return
    if (!info.isDirectory()) {
      found.push(current)
      return
    }
    for (const name of await readdir(current)) await visit(join(current, name))
  }
  await visit(path)
  return found
}

const RESTART_MANAGER_PROBE = String.raw`
$files = [string[]]@([Console]::In.ReadToEnd() | ConvertFrom-Json)
Add-Type -TypeDefinition @"
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Text;
public static class OmoRestartManager {
  [StructLayout(LayoutKind.Sequential)] struct RmUniqueProcess { public int ProcessId; public long StartTime; }
  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)] struct RmProcessInfo {
    public RmUniqueProcess Process;
    [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 256)] public string AppName;
    [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 64)] public string ServiceShortName;
    public int ApplicationType; public uint AppStatus; public uint TsSessionId;
    [MarshalAs(UnmanagedType.Bool)] public bool Restartable;
  }
  [DllImport("rstrtmgr.dll", CharSet = CharSet.Unicode)] static extern int RmStartSession(out uint handle, int flags, StringBuilder key);
  [DllImport("rstrtmgr.dll")] static extern int RmEndSession(uint handle);
  [DllImport("rstrtmgr.dll", CharSet = CharSet.Unicode)] static extern int RmRegisterResources(uint handle, uint fileCount, string[] files, uint appCount, IntPtr apps, uint serviceCount, string[] services);
  [DllImport("rstrtmgr.dll")] static extern int RmGetList(uint handle, out uint needed, ref uint count, [In, Out] RmProcessInfo[] info, ref uint reasons);
  public static string[] Lockers(string[] files) {
    uint handle;
    if (RmStartSession(out handle, 0, new StringBuilder(64)) != 0) throw new Exception("RmStartSession failed");
    try {
      if (RmRegisterResources(handle, (uint)files.Length, files, 0, IntPtr.Zero, 0, null) != 0) throw new Exception("RmRegisterResources failed");
      uint needed, count = 0, reasons = 0;
      RmProcessInfo[] info = null;
      int rc = RmGetList(handle, out needed, ref count, null, ref reasons);
      if (rc == 234) { info = new RmProcessInfo[needed]; count = needed; rc = RmGetList(handle, out needed, ref count, info, ref reasons); }
      if (rc != 0) throw new Exception("RmGetList failed: " + rc);
      var names = new List<string>();
      for (int i = 0; i < count; i++) {
        string image = info[i].AppName;
        try { image = System.Diagnostics.Process.GetProcessById(info[i].Process.ProcessId).ProcessName; } catch (ArgumentException) { image = info[i].AppName + ", exited"; }
        names.Add(image + " (pid " + info[i].Process.ProcessId + ")");
      }
      return names.ToArray();
    } finally { RmEndSession(handle); }
  }
}
"@
ConvertTo-Json -Compress -InputObject @([OmoRestartManager]::Lockers($files))
`
