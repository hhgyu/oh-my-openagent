import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdtemp, readdir, readFile, rename, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  isTransientWindowsLockError,
  LockedOutputError,
  removePath,
  replaceFileContents,
} from "./windows-safe-replace.mjs"

function codeError(code: string): Error {
  return Object.assign(new Error(`${code}: simulated`), { code })
}

describe("replaceFileContents", () => {
  let root = ""
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "omo-safe-replace-"))
  })
  afterEach(async () => {
    await rm(root, { recursive: true, force: true })
  })

  describe("#given a target that already holds the same bytes", () => {
    test("#when replaced #then nothing is renamed and the call reports no change", async () => {
      const target = join(root, "bundle.js")
      await writeFile(target, "same")
      const renames: string[] = []

      const changed = await replaceFileContents(target, "same", {
        rename: async (from, to) => {
          renames.push(`${from}->${to}`)
        },
      })

      expect(changed).toBe(false)
      expect(renames).toEqual([])
    })
  })

  describe("#given a target with different bytes", () => {
    test("#when replaced #then the new bytes land and no temp file is left beside it", async () => {
      const target = join(root, "bundle.js")
      await writeFile(target, "old")

      const changed = await replaceFileContents(target, "new")

      expect(changed).toBe(true)
      expect(await readFile(target, "utf8")).toBe("new")
      expect(await readdir(root)).toEqual(["bundle.js"])
    })
  })

  describe("#given Windows reports the target busy for a while", () => {
    test("#when the holder lets go within the retry budget #then the rename succeeds after bounded waits", async () => {
      const target = join(root, "bundle.js")
      await writeFile(target, "old")
      const failures = ["EBUSY", "UNKNOWN"]
      const waits: number[] = []

      const changed = await replaceFileContents(target, "new", {
        platform: "win32",
        retryDelaysMs: [5, 10, 20],
        sleep: async (ms) => {
          waits.push(ms)
        },
        rename: async (from, to) => {
          const code = failures.shift()
          if (code !== undefined) throw codeError(code)
          await rename(from, to)
        },
      })

      expect(changed).toBe(true)
      expect(waits).toEqual([5, 10])
      expect(await readFile(target, "utf8")).toBe("new")
    })
  })

  describe("#given Windows keeps the target locked past the retry budget", () => {
    test("#when replaced #then it fails loudly naming the holder and leaves the old bytes and no temp file", async () => {
      const target = join(root, "bundle.js")
      await writeFile(target, "old")
      let attempts = 0

      const result = replaceFileContents(target, "new", {
        platform: "win32",
        retryDelaysMs: [1, 1],
        sleep: async () => {},
        describeLockers: async () => ["opencode (pid 4242)"],
        rename: async () => {
          attempts += 1
          throw codeError("EPERM")
        },
      })

      const error = await result.then(
        () => undefined,
        (caught: unknown) => caught,
      )
      expect(error).toBeInstanceOf(LockedOutputError)
      expect(error instanceof LockedOutputError && error.lockers).toEqual(["opencode (pid 4242)"])
      expect(error instanceof Error && error.message).toContain("opencode (pid 4242)")
      expect(attempts).toBe(3)
      expect(await readFile(target, "utf8")).toBe("old")
      expect(await readdir(root)).toEqual(["bundle.js"])
    })
  })

  describe("#given a sharing-violation code off Windows", () => {
    test("#when replaced #then the error surfaces at once without retrying", async () => {
      const target = join(root, "bundle.js")
      let attempts = 0

      const error = await replaceFileContents(target, "new", {
        platform: "linux",
        sleep: async () => {
          throw new Error("must not wait")
        },
        rename: async () => {
          attempts += 1
          throw codeError("EBUSY")
        },
      }).then(
        () => undefined,
        (caught: unknown) => caught,
      )

      expect(error instanceof Error && "code" in error && error.code).toBe("EBUSY")
      expect(attempts).toBe(1)
    })
  })
})

describe("removePath", () => {
  test("#given a stale entry Windows keeps locked #when removed #then the failure names the holder", async () => {
    const error = await removePath("/nowhere/stale.md", {
      platform: "win32",
      retryDelaysMs: [],
      describeLockers: async () => ["pwsh (pid 7)"],
      remove: async () => {
        throw codeError("EBUSY")
      },
    }).then(
      () => undefined,
      (caught: unknown) => caught,
    )

    expect(error instanceof LockedOutputError && error.path).toBe("/nowhere/stale.md")
    expect(error instanceof Error && error.message).toContain("pwsh (pid 7)")
  })
})

describe("isTransientWindowsLockError", () => {
  test("#given Windows lock codes and other errors #then only the lock codes on win32 count as transient", () => {
    for (const code of ["EBUSY", "EPERM", "EACCES", "ENOTEMPTY", "UNKNOWN"]) {
      expect(isTransientWindowsLockError(codeError(code), "win32")).toBe(true)
      expect(isTransientWindowsLockError(codeError(code), "linux")).toBe(false)
    }
    expect(isTransientWindowsLockError(codeError("ENOENT"), "win32")).toBe(false)
    expect(isTransientWindowsLockError("EBUSY", "win32")).toBe(false)
  })
})
