import { spawnSync } from "node:child_process"
import { randomUUID } from "node:crypto"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { closeSync, openSync, readFileSync, unlinkSync } from "../fs/resilient"

export type DiagnosticCommandRunner = (
  file: string,
  args: readonly string[],
  timeoutMs: number,
  label: string,
) => string

// The output goes to a temp file, never a pipe: spawnSync caps a pipe at maxBuffer (1 MiB by default),
// and a host running thousands of processes overflows any fixed cap, which lost the whole table to
// ENOBUFS (omo #12801). A file has no such cap.
export const captureToFile: DiagnosticCommandRunner = (file, args, timeoutMs, label) => {
  const output = join(tmpdir(), `omo-git-timeout-snapshot-${process.pid}-${randomUUID()}.txt`)
  let fd: number | undefined
  try {
    fd = openSync(output, "wx", 0o600)
    const command = spawnSync(file, [...args], { stdio: ["ignore", fd, fd], timeout: timeoutMs, windowsHide: true })
    if (command.error) return `${label} failed: ${command.error.message}`
    return readFileSync(output, "utf8")
  } catch (error) {
    return `${label} failed: ${error instanceof Error ? error.message : String(error)}`
  } finally {
    if (fd !== undefined) {
      closeSync(fd)
      unlinkSync(output)
    }
  }
}
