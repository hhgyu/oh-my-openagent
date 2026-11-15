import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { chmod, mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { syncDirectory } from "./sync-directory.mjs"
import { LockedOutputError } from "./windows-safe-replace.mjs"

async function listRelative(root: string): Promise<string[]> {
  const entries = await readdir(root, { recursive: true })
  return entries.map((entry) => entry.replaceAll("\\", "/")).sort()
}

describe("syncDirectory", () => {
  let root = ""
  let source = ""
  let target = ""
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "omo-sync-directory-"))
    source = join(root, "source")
    target = join(root, "target")
    await mkdir(join(source, "skill", "scripts"), { recursive: true })
    await writeFile(join(source, "skill", "SKILL.md"), "current skill")
    await writeFile(join(source, "skill", "scripts", "run.sh"), "#!/bin/sh\n")
    await chmod(join(source, "skill", "scripts", "run.sh"), 0o755)
  })
  afterEach(async () => {
    await rm(root, { recursive: true, force: true })
  })

  describe("#given a target holding stale, changed and missing entries", () => {
    test("#when synced #then the target mirrors the source exactly", async () => {
      await mkdir(join(target, "skill"), { recursive: true })
      await mkdir(join(target, "removed-skill", "nested"), { recursive: true })
      await writeFile(join(target, "skill", "SKILL.md"), "old skill")
      await writeFile(join(target, "skill", "obsolete.md"), "obsolete")
      await writeFile(join(target, "removed-skill", "nested", "file.md"), "gone")

      const summary = await syncDirectory(source, target)

      expect(await listRelative(target)).toEqual(await listRelative(source))
      expect(await readFile(join(target, "skill", "SKILL.md"), "utf8")).toBe("current skill")
      const executable = (path: string) => stat(path).then((info) => info.mode & 0o111)
      expect(await executable(join(target, "skill", "scripts", "run.sh"))).toBe(
        await executable(join(source, "skill", "scripts", "run.sh")),
      )
      expect(summary).toEqual({ written: 2, unchanged: 0, removed: 2 })
    })
  })

  describe("#given a target already in sync", () => {
    test("#when synced again #then no file is rewritten", async () => {
      await syncDirectory(source, target)
      const renames: string[] = []

      const summary = await syncDirectory(source, target, {
        rename: async (from) => {
          renames.push(from)
        },
      })

      expect(renames).toEqual([])
      expect(summary).toEqual({ written: 0, unchanged: 2, removed: 0 })
    })
  })

  describe("#given a stale entry Windows keeps locked", () => {
    test("#when synced #then the sync fails loudly instead of leaving stale output", async () => {
      await mkdir(join(target, "skill"), { recursive: true })
      await writeFile(join(target, "skill", "obsolete.md"), "obsolete")

      const error = await syncDirectory(source, target, {
        platform: "win32",
        retryDelaysMs: [1],
        sleep: async () => {},
        describeLockers: async () => ["opencode (pid 99)"],
        remove: async () => {
          throw Object.assign(new Error("EBUSY: simulated"), { code: "EBUSY" })
        },
      }).then(
        () => undefined,
        (caught: unknown) => caught,
      )

      expect(error).toBeInstanceOf(LockedOutputError)
      expect(error instanceof Error && error.message).toContain("opencode (pid 99)")
    })
  })

  describe("#given a missing source", () => {
    test("#when synced #then it refuses rather than emptying the target", async () => {
      await mkdir(target, { recursive: true })
      await writeFile(join(target, "keep.md"), "keep")

      await expect(syncDirectory(join(root, "missing"), target)).rejects.toThrow("is not a directory")
      expect(await readFile(join(target, "keep.md"), "utf8")).toBe("keep")
    })
  })
})
