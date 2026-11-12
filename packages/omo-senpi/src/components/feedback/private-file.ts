import { spawnSync } from "node:child_process"
import { chmodSync, closeSync, openSync, writeFileSync } from "node:fs"

const protectWindowsPath = (path: string, kind: "file" | "dir"): void => {
  const script = `
$ErrorActionPreference = 'Stop'
trap { [Console]::Error.WriteLine($_.Exception.Message); exit 1 }
$sid = [System.Security.Principal.WindowsIdentity]::GetCurrent().User
if ($env:OMO_FEEDBACK_KIND -eq 'dir') {
  $acl = [System.Security.AccessControl.DirectorySecurity]::new()
  $inherit = [System.Security.AccessControl.InheritanceFlags]'ContainerInherit, ObjectInherit'
} else {
  $acl = [System.Security.AccessControl.FileSecurity]::new()
  $inherit = [System.Security.AccessControl.InheritanceFlags]::None
}
$rule = [System.Security.AccessControl.FileSystemAccessRule]::new($sid, 'FullControl', $inherit, 'None', 'Allow')
$acl.SetAccessRuleProtection($true, $false)
$acl.SetOwner($sid)
$acl.AddAccessRule($rule)
if ($env:OMO_FEEDBACK_KIND -eq 'dir') {
  [System.IO.Directory]::SetAccessControl($env:OMO_FEEDBACK_PATH, $acl)
} else {
  [System.IO.File]::SetAccessControl($env:OMO_FEEDBACK_PATH, $acl)
}
`
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => key.toLowerCase() !== "psmodulepath"))
  const result = spawnSync(
    "powershell.exe",
    ["-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(script, "utf16le").toString("base64")],
    {
      env: { ...env, OMO_FEEDBACK_PATH: path, OMO_FEEDBACK_KIND: kind },
      encoding: "utf8",
      timeout: 10_000,
      windowsHide: true,
    },
  )
  if (result.error !== undefined) throw result.error
  if (result.status !== 0) throw new Error("Could not protect the feedback path with an owner-only Windows ACL")
}

export const protectFeedbackDirectory = (path: string): void => {
  if (process.platform === "win32") protectWindowsPath(path, "dir")
  else chmodSync(path, 0o700)
}

export const writePrivateFeedbackFile = (path: string, contents: string): void => {
  if (process.platform === "win32") {
    closeSync(openSync(path, "a", 0o600))
    protectWindowsPath(path, "file")
  }
  writeFileSync(path, contents, { mode: 0o600 })
  if (process.platform !== "win32") chmodSync(path, 0o600)
}
