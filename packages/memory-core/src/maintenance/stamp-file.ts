// The maintenance attempt stamp (`<identity runtime>/maintenance.json`): read as JSON, written durably
// (fsync of the file, rename, fsync of the directory), the same bytes omo-senpi `writeRunJsonAtomic` wrote.

import { randomUUID } from "node:crypto"
import { dirname } from "node:path"

import { open, readFile, rename, unlink } from "../fs/resilient"

export async function readMaintenanceJson(path: string): Promise<unknown> {
  return JSON.parse(await readFile(path, "utf8")) as unknown
}

export async function writeMaintenanceJsonAtomic(path: string, value: unknown): Promise<void> {
  const temporary = `${path}.tmp-${process.pid}-${randomUUID()}`
  const file = await open(temporary, "wx", 0o600)
  let renamed = false
  try {
    try {
      await file.writeFile(`${JSON.stringify(value, null, 2)}\n`, "utf8")
      await file.sync()
    } finally {
      await file.close()
    }
    await rename(temporary, path)
    renamed = true
    await syncDirectory(dirname(path))
  } finally {
    if (!renamed) await unlink(temporary).catch(() => undefined)
  }
}

async function syncDirectory(path: string): Promise<void> {
  try {
    const directory = await open(path, "r")
    try {
      await directory.sync()
    } finally {
      await directory.close()
    }
  } catch (error) {
    const code = error instanceof Error && "code" in error ? error.code : undefined
    if (process.platform !== "win32" || !["EISDIR", "EPERM"].includes(String(code))) throw error
  }
}
