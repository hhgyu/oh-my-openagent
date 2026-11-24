import { describe, expect, onTestFinished, spyOn, test } from "bun:test"
import { spawnSync } from "node:child_process"
import { chmod, link, lstat, mkdir, open, readdir, readFile, rm, stat, symlink, writeFile } from "node:fs/promises"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  createStateFileStore,
  dirRefusal,
  fileRefusal,
  stateFileDirectory,
  StateFileRefused,
  writeStateFile,
} from "./state-file-store"
import { temporaryHome } from "./test-support"

const uid = process.getuid?.() ?? 0
const codec = {
  parse: (text: string) => JSON.parse(text) as { readonly token: string },
  serialize: (value: { readonly token: string }) => JSON.stringify(value),
}
const secret = { token: "synthetic-state-file-secret" }

async function fileStore(home: string) {
  const lines: string[] = []
  const store = createStateFileStore({
    api: "https://api.omo.dev",
    name: "omo-cli-test.json",
    home,
    codec,
    failure: (message) => new Error(message),
    log: (line) => lines.push(line),
  })
  return { store, lines, dir: stateFileDirectory(home), file: join(stateFileDirectory(home), "omo-cli-test.json") }
}

function supportsFifo(): boolean {
  if (process.platform === "win32") return false
  const dir = mkdtempSync(join(tmpdir(), "omo-fifo-probe-"))
  try {
    return spawnSync("mkfifo", [join(dir, "pipe")]).status === 0
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

describe.skipIf(process.platform === "win32")("the Linux sign-in state file (#7185b)", () => {
  test("#given a wide umask #when a sign-in is written #then the dir is 0700 and the file 0600", async () => {
    const home = await temporaryHome()
    const { store, dir, file } = await fileStore(home)
    const umask = process.umask(0)
    onTestFinished(() => {
      process.umask(umask)
    })
    await store.write(secret)
    expect((await stat(dir)).mode & 0o777).toBe(0o700)
    expect((await stat(file)).mode & 0o777).toBe(0o600)
    expect(await store.read()).toEqual(secret)
  })

  test("direct file creation preserves owner permissions under restrictive umask", async () => {
    const home = await temporaryHome()
    const { dir, file } = await fileStore(home)
    await mkdir(join(home, ".omo"), { recursive: true })
    const mask = process.umask(0o777)
    try {
      await writeStateFile(dir, "omo-cli-test.json", "synthetic", uid)
    } finally {
      process.umask(mask)
    }
    expect((await stat(dir)).mode & 0o777).toBe(0o700)
    expect((await stat(file)).mode & 0o777).toBe(0o600)
  })

  test("#when a write replaces the file #then no temp file is left beside it", async () => {
    const home = await temporaryHome()
    const { store, dir } = await fileStore(home)
    await store.write(secret)
    await store.write({ token: "second" })
    expect(await readdir(dir)).toEqual(["omo-cli-test.json"])
    expect(await store.read()).toEqual({ token: "second" })
  })

  test("#given a group- or world-open file #then it is refused, read as signed out, with one line and no content", async () => {
    for (const mode of [0o640, 0o604, 0o620, 0o602]) {
      const home = await temporaryHome()
      const { store, file, lines } = await fileStore(home)
      await store.write(secret)
      await chmod(file, mode)
      expect(await store.read()).toBeNull()
      expect(lines).toHaveLength(1)
      expect(lines[0]).toContain("open")
      expect(lines.join("\n")).not.toContain(secret.token)
      await expect(store.write({ token: "replacement" })).rejects.toThrow("refused")
      expect(await readFile(file, "utf8")).toBe(JSON.stringify(secret))
    }
  })

  test("a refused removal snapshot cannot clear a replacement with the same permissions", async () => {
    const { store, file } = await fileStore(await temporaryHome())
    await store.write(secret)
    await chmod(file, 0o640)
    let remove: (() => Promise<void>) | undefined
    await expect(
      store.snapshot(undefined, (action) => {
        remove = action
      }),
    ).rejects.toThrow()
    await rm(file)
    await writeFile(file, "synthetic replacement", { mode: 0o640 })
    if (!remove) throw new Error("missing refused snapshot")
    await expect(remove()).rejects.toThrow("changed")
    expect(await readFile(file, "utf8")).toBe("synthetic replacement")
  })

  test("#given a symlink in the file's place #then its target is never read", async () => {
    const home = await temporaryHome()
    const { store, dir, file, lines } = await fileStore(home)
    await mkdir(dir, { recursive: true, mode: 0o700 })
    const target = join(home, "elsewhere.json")
    await writeFile(target, JSON.stringify(secret), { mode: 0o600 })
    await symlink(target, file)
    expect(await store.read()).toBeNull()
    expect(lines).toHaveLength(1)
    expect(lines[0]).toContain("symlink")
    await store.clear()
    expect(await lstat(file).catch(() => null)).toBeNull()
    expect(await readFile(target, "utf8")).toBe(JSON.stringify(secret))
  })

  test("clear syncs its directory after the last credential-bearing link is gone", async () => {
    const home = await temporaryHome(),
      { store, dir } = await fileStore(home)
    await store.write(secret)
    const handle = await open(dir, "r"),
      proto: typeof handle = Object.getPrototypeOf(handle)
    const sync = proto.sync
    let synced = false
    const expected = await handle.stat()
    const spy = spyOn(proto, "sync").mockImplementation(async function (this: typeof handle) {
      const st = await this.stat()
      if (st.dev === expected.dev && st.ino === expected.ino) synced = (await readdir(dir)).length === 0
      await sync.call(this)
    })
    try {
      await store.clear()
      expect(synced).toBe(true)
    } finally {
      spy.mockRestore()
      await handle.close()
    }
  })

  test.each(["completed", "aborted"] as const)(
    "first access recovers a %s unlink without touching another slot",
    async (state) => {
      const home = await temporaryHome()
      const { store, file, dir } = await fileStore(home)
      await store.write(secret)
      const backup = join(dir, ".omo-cli-test.json.0123456789abcdef.retiring")
      const neighbor = join(dir, ".omo-cli-other.json.0123456789abcdef.retiring")
      await link(file, backup)
      await writeFile(neighbor, "synthetic-neighbor", { mode: 0o600 })
      if (state === "completed") await rm(file)
      const restarted = (await fileStore(home)).store
      expect(await restarted.present()).toBe(state === "aborted")
      expect(await readdir(dir)).not.toContain(".omo-cli-test.json.0123456789abcdef.retiring")
      expect(await restarted.read()).toEqual(state === "aborted" ? secret : null)
      expect(await readFile(neighbor, "utf8")).toBe("synthetic-neighbor")
    },
  )

  test("a directory sync failure after credential unlink restores the original sign-in", async () => {
    const { store, dir, file } = await fileStore(await temporaryHome())
    await store.write(secret)
    const handle = await open(dir, "r"),
      proto: typeof handle = Object.getPrototypeOf(handle)
    const identity = await handle.stat(),
      sync = proto.sync
    const spy = spyOn(proto, "sync").mockImplementation(async function (this: typeof handle) {
      const st = await this.stat()
      if (st.ino === identity.ino && st.dev === identity.dev && !(await lstat(file).catch(() => null)))
        throw Object.assign(new Error("synthetic sync failure"), { code: "EIO" })
      await sync.call(this)
    })
    try {
      await expect(store.clear()).rejects.toThrow()
      expect(await store.read()).toEqual(secret)
    } finally {
      spy.mockRestore()
      await handle.close()
    }
  })

  test.skipIf(!supportsFifo())("#given a FIFO in the file's place #then it is refused without blocking", async () => {
    const home = await temporaryHome()
    const { store, dir, file, lines } = await fileStore(home)
    await mkdir(dir, { recursive: true, mode: 0o700 })
    expect(spawnSync("mkfifo", ["-m", "600", file]).status).toBe(0)
    expect(await store.read()).toBeNull()
    expect(lines[0]).toContain("not-a-file")
  })

  test("#given an open directory #then a read is refused and a write writes nothing", async () => {
    const home = await temporaryHome()
    const { store, dir, file, lines } = await fileStore(home)
    await store.write(secret)
    await chmod(dir, 0o755)
    expect(await store.read()).toBeNull()
    expect(lines[0]).toContain("dir-open")
    await chmod(file, 0o600)
    await expect(writeStateFile(dir, "other.json", "x", uid)).rejects.toBeInstanceOf(StateFileRefused)
    expect(await readdir(dir)).toEqual(["omo-cli-test.json"])
    await expect(store.write({ token: "replaced" })).rejects.toThrow("dir-open")
  })

  test("#given a directory in the file's place or a file in the dir's place #then both are refused", async () => {
    const home = await temporaryHome()
    const { store, file, lines } = await fileStore(home)
    await mkdir(file, { recursive: true, mode: 0o700 })
    expect(await store.read()).toBeNull()
    expect(lines[0]).toContain("not-a-file")
    const other = await temporaryHome()
    await mkdir(join(other, ".omo"), { recursive: true })
    await writeFile(stateFileDirectory(other), "not a dir", { mode: 0o600 })
    const second = await fileStore(other)
    expect(await second.store.read()).toBeNull()
    expect(second.lines[0]).toContain("dir-not-a-directory")
  })

  test("#then another user's file or dir is refused, judged on the stat alone", async () => {
    const home = await temporaryHome()
    const { store, dir, file } = await fileStore(home)
    await store.write(secret)
    expect(fileRefusal(await stat(file), uid)).toBeUndefined()
    expect(fileRefusal(await stat(file), uid + 1)).toBe("other-owner")
    expect(dirRefusal(await stat(dir), uid)).toBeUndefined()
    expect(dirRefusal(await stat(dir), uid + 1)).toBe("dir-other-owner")
    expect(dirRefusal(await stat(file), uid)).toBe("dir-not-a-directory")
    expect(fileRefusal(await stat(dir), uid)).toBe("not-a-file")
  })

  test("#when cleared #then the file is gone and a read is signed out", async () => {
    const home = await temporaryHome()
    const { store, file } = await fileStore(home)
    await store.write(secret)
    expect(await store.present()).toBe(true)
    await store.clear()
    expect(await lstat(file).catch(() => null)).toBeNull()
    expect(await store.present()).toBe(false)
    expect(await store.read()).toBeNull()
  })

  test("#given a temp file left by a crash before its rename #then the next write and a sign-out remove it", async () => {
    const home = await temporaryHome()
    const { store, dir } = await fileStore(home)
    await store.write(secret)
    const leftover = join(dir, ".omo-cli-test.json.0123456789abcdef.tmp")
    await writeFile(leftover, JSON.stringify(secret), { mode: 0o600 })
    await store.write({ token: "second" })
    expect(await readdir(dir)).toEqual(["omo-cli-test.json"])
    await writeFile(leftover, JSON.stringify(secret), { mode: 0o600 })
    await store.clear()
    expect(await readdir(dir)).toEqual([])
  })
})

test.skipIf(process.platform === "win32")(
  "clear refuses a redirected state directory and retains its target",
  async () => {
    const target = await fileStore(await temporaryHome())
    await target.store.write(secret)
    const home = await temporaryHome()
    const local = await fileStore(home)
    await mkdir(join(home, ".omo"), { recursive: true })
    await symlink(target.dir, local.dir)
    await expect(local.store.clear()).rejects.toThrow()
    expect(await target.store.read()).toEqual(secret)
  },
)

test.skipIf(process.platform === "win32")(
  "present distinguishes a missing entry from a path it cannot inspect",
  async () => {
    const home = await temporaryHome()
    const { store, dir } = await fileStore(home)
    expect(await store.present()).toBe(false)
    await mkdir(join(home, ".omo"), { recursive: true })
    await writeFile(dir, "not a directory")
    await expect(store.present()).rejects.toThrow()
  },
)
