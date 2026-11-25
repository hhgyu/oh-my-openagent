import { createHash, randomBytes } from "node:crypto"
import { constants, type Stats } from "node:fs"
import { chmod, link, lstat, mkdir, open, readdir, rename, rm } from "node:fs/promises"
import { type as osType } from "node:os"
import { dirname, join } from "node:path"
import { checkCredentialDirectory, checkCredentialParents, CredentialParentError } from "./credential-parent"
import { accountHome } from "./account-home"
import { withCredentialLock } from "./credential-lock"
import type { SealedStore } from "./keystore"

/**
 * The shared OmO sign-in at rest on a Linux machine with no Secret Service (#7185b, "the Tailscale way", like
 * tailscaled.state): a plain file only this user can read, in a directory only this user can enter. The file is the
 * credential, so every read proves it is still private before using it, and a write never leaves a partial or briefly
 * readable file behind. The desktop keeps its own sign-in under the same rules.
 */
const ACCOUNT_STATE_DIR = "account-state"

const { O_RDONLY, O_WRONLY, O_CREAT, O_EXCL, O_NOFOLLOW, O_NONBLOCK, O_DIRECTORY } = constants
const GROUP_OR_WORLD = 0o077

export type StateFileRefusal =
  "dir-not-a-directory" | "dir-other-owner" | "dir-open" | "symlink" | "not-a-file" | "other-owner" | "open"

/** The file or its directory is not private to this user: it is never used and never written to. */
export class StateFileRefused extends Error {
  constructor(
    readonly refusal: StateFileRefusal,
    detail?: string,
  ) {
    super(`the private sign-in file was refused (${refusal})${detail ? `: ${detail}` : ""}`)
  }
}

export const stateFileDirectory = (home: string): string => join(home, ".omo", ACCOUNT_STATE_DIR)

const errnoCode = (error: unknown): string | undefined =>
  typeof error === "object" && error !== null && "code" in error && typeof error.code === "string"
    ? error.code
    : undefined

/**
 * The owner every entry must have, or undefined on a host with no POSIX owner to compare (no process.getuid, as on
 * Windows): there an entry must still be a real directory or regular file, but owner and mode bits are not judged.
 */
type Owner = number | undefined

/** The directory's own entry (never followed): a real directory of this user nobody else can enter. */
export const dirRefusal = (stat: Stats, uid: Owner): StateFileRefusal | undefined =>
  !stat.isDirectory()
    ? "dir-not-a-directory"
    : uid === undefined
      ? undefined
      : stat.uid !== uid
        ? "dir-other-owner"
        : (stat.mode & GROUP_OR_WORLD) !== 0
          ? "dir-open"
          : undefined

/** The opened file itself: a regular file of this user nobody else can read or write. */
export const fileRefusal = (stat: Stats, uid: Owner): StateFileRefusal | undefined =>
  !stat.isFile()
    ? "not-a-file"
    : uid === undefined
      ? undefined
      : stat.uid !== uid
        ? "other-owner"
        : (stat.mode & GROUP_OR_WORLD) !== 0
          ? "open"
          : undefined

async function checkDir(dir: string, uid: Owner): Promise<boolean> {
  if (!checkCredentialParents(dirname(dirname(dir)), uid)) return false
  const stat = await lstat(dir).catch((error: unknown) => {
    if (errnoCode(error) === "ENOENT") return null
    throw error
  })
  if (stat === null) return false
  const refusal = dirRefusal(stat, uid)
  if (refusal !== undefined)
    throw new StateFileRefused(
      refusal,
      `${dir} (mode ${(stat.mode & 0o7777).toString(8).padStart(4, "0")}, owner ${stat.uid}). Inspect the path; use a real directory owned by UID ${uid} with mode 0700`,
    )
  return true
}

/**
 * The file's text, null when there is none. It is opened without following a symlink and judged on the open
 * descriptor, so it cannot be swapped between the check and the read; O_NONBLOCK keeps a FIFO from hanging the open.
 */
async function readStateFile(dir: string, name: string, uid: Owner): Promise<{ text: string; version: string } | null> {
  if (!(await checkDir(dir, uid))) return null
  const handle = await open(join(dir, name), O_RDONLY | O_NOFOLLOW | O_NONBLOCK).catch((error: unknown) => {
    const code = errnoCode(error)
    if (code === "ENOENT") return null
    if (code === "ELOOP") throw new StateFileRefused("symlink")
    throw error
  })
  if (handle === null) return null
  try {
    const stat = await handle.stat()
    const refusal = fileRefusal(stat, uid)
    if (refusal !== undefined) throw new StateFileRefused(refusal)
    const bytes = await handle.readFile()
    const digest = createHash("sha256").update(bytes).digest("hex")
    return { text: bytes.toString("utf8"), version: [stat.dev, stat.ino, stat.ctimeMs, digest].join(":") }
  } finally {
    await handle.close()
  }
}

// Under the credential lock no other write is running, so a temp file of this name is one a crash left before its
// rename: it holds a credential and is removed, without following a symlink.
async function removeTempLeftovers(dir: string, name: string): Promise<void> {
  const entries = await readdir(dir).catch((error: unknown) => {
    if (errnoCode(error) === "ENOENT") return []
    throw error
  })
  for (const entry of entries)
    if (entry.startsWith(`.${name}.`) && entry.endsWith(".tmp")) await rm(join(dir, entry), { force: true })
}

function isRetiring(entry: string, name: string): boolean {
  const prefix = `.${name}.`
  return entry.startsWith(prefix) && /^[a-f0-9]{16}\.retiring$/.test(entry.slice(prefix.length))
}

// The canonical name decides the outcome: present means keep it; absent means stay signed out.
// A retiring link is never a source for startup restoration, even if the slot has since been reused.
async function recoverRetiring(dir: string, name: string): Promise<void> {
  const entries = (await readdir(dir)).filter((entry) => isRetiring(entry, name))
  for (const entry of entries) await rm(join(dir, entry))
  if (entries.length > 0) await syncDirectory(dir, true)
}

async function mkdirPrivate(dir: string): Promise<void> {
  try {
    await mkdir(dir, { mode: 0o700 })
  } catch (error) {
    if (errnoCode(error) === "EEXIST") return
    throw error
  }
  await chmod(dir, 0o700)
  await syncDirectory(dirname(dir), true)
}

/**
 * Replaces the file atomically: a temp file created 0600 (never wider, whatever the umask) in the same private dir,
 * written and synced, then renamed over the old one, then the dir synced. A refused dir is never written to.
 */
export async function writeStateFile(
  dir: string,
  name: string,
  contents: string,
  uid: Owner,
  log: (line: string) => void = (line) => process.stderr.write(`${line}\n`),
): Promise<void> {
  const parent = dirname(dir),
    home = dirname(parent)
  if (!checkCredentialDirectory(home, uid))
    throw new CredentialParentError(`Missing credential home ${home}; create a private directory owned by UID ${uid}.`)
  await mkdirPrivate(parent)
  checkCredentialDirectory(parent, uid)
  await mkdirPrivate(dir)
  await checkDir(dir, uid)
  await recoverRetiring(dir, name)
  await removeTempLeftovers(dir, name)
  const temp = join(dir, `.${name}.${randomBytes(8).toString("hex")}.tmp`)
  try {
    const handle = await open(temp, O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW, 0o600)
    try {
      await handle.chmod(0o600)
      await handle.writeFile(contents, "utf8")
      await handle.sync()
    } finally {
      await handle.close()
    }
    const entry = join(dir, name)
    const previous = await lstat(entry).catch((error: unknown) => {
      if (errnoCode(error) === "ENOENT") return null
      throw error
    })
    if (previous) {
      const refusal = previous.isSymbolicLink() ? "symlink" : fileRefusal(previous, uid)
      if (refusal) throw new StateFileRefused(refusal)
    }
    await rename(temp, entry)
  } catch (error) {
    await rm(temp, { force: true })
    throw error
  }
  // The rename is durable only once the directory entry is; a filesystem that cannot sync a directory still renamed.
  try {
    await syncDirectory(dir, true)
  } catch (error) {
    log(
      `omo: the private sign-in file was written in ${dir}, but its durability could not be confirmed (${errnoCode(error) ?? "unknown"}).`,
    )
  }
}

// Windows refuses to flush a directory handle (EPERM) on every filesystem; NTFS journals the rename itself.
const hostCannotSyncDirectories = (error: unknown): boolean => osType() === "Windows_NT" && errnoCode(error) === "EPERM"

async function syncDirectory(dir: string, required = false): Promise<void> {
  const directory = await open(dir, O_RDONLY | O_DIRECTORY | O_NOFOLLOW)
  try {
    await directory.sync().catch((error: unknown) => {
      if (hostCannotSyncDirectories(error)) return
      if (required || !["EINVAL", "ENOTSUP", "EOPNOTSUPP"].includes(errnoCode(error) ?? "")) throw error
    })
  } finally {
    await directory.close()
  }
}

/** A symlink in the file's place is unlinked itself, never followed to its target. */
async function removeStateFile(
  dir: string,
  name: string,
  uid: Owner,
  verify?: (path: string, linked: boolean) => Promise<void>,
): Promise<void> {
  await recoverRetiring(dir, name)
  await removeTempLeftovers(dir, name)
  const entry = join(dir, name)
  const backup = join(dir, `.${name}.${randomBytes(8).toString("hex")}.retiring`)
  await verify?.(entry, false)
  try {
    await link(entry, backup)
  } catch (error) {
    if (!verify && errnoCode(error) === "ENOENT") return syncDirectory(dir, true)
    if (!verify && errnoCode(error) === "EPERM" && (await lstat(entry)).uid !== uid) {
      // Linux can forbid hard links to a foreign inode. This entry cannot be a usable state file.
      await rm(entry)
      await syncDirectory(dir, true)
      return
    }
    throw error
  }
  let removed = false
  try {
    await verify?.(backup, true)
    await verify?.(entry, true)
    await rm(entry)
    removed = true
    await syncDirectory(dir, true)
  } catch (error) {
    if (removed) await link(backup, entry)
    await rm(backup)
    await syncDirectory(dir, true)
    throw error
  }
  await rm(backup)
  await syncDirectory(dir, true)
}

async function captureRefusedRemoval(
  dir: string,
  name: string,
  uid: Owner,
  failure: (message: string) => Error,
  onRefused: (clear: () => Promise<void>) => void,
): Promise<Error | undefined> {
  const path = join(dir, name)
  const first = await lstat(path, { bigint: true }).catch((error: unknown) => {
    if (errnoCode(error) === "ENOENT") return null
    throw error
  })
  if (first) {
    const mode = Number(first.mode & 0o7777n)
      .toString(8)
      .padStart(4, "0")
    const reason = first.isSymbolicLink()
      ? "symlink"
      : !first.isFile()
        ? "not a regular file"
        : uid === undefined
          ? null
          : first.uid !== BigInt(uid)
            ? "foreign owner"
            : (first.mode & 0o077n) !== 0n
              ? "unsafe permissions"
              : null
    if (reason) {
      const diagnosis = failure(
        `Refused ${path} (${reason}, mode ${mode}, owner ${first.uid}). Inspect the entry and its ownership; use an owned regular file with mode 0600.`,
      )
      onRefused(async () => {
        if (reason !== "unsafe permissions") throw diagnosis
        try {
          if (!(await checkDir(dir, uid))) throw diagnosis
          await removeStateFile(dir, name, uid, async (candidate, linked) => {
            const now = await lstat(candidate, { bigint: true })
            if (
              !now.isFile() ||
              now.uid !== first.uid ||
              now.dev !== first.dev ||
              now.ino !== first.ino ||
              (!linked && now.ctimeNs !== first.ctimeNs) ||
              now.mtimeNs !== first.mtimeNs ||
              now.size !== first.size ||
              now.mode !== first.mode
            )
              throw failure(
                `The entry at ${path} changed since the refused snapshot (mode ${mode}); it was kept. Inspect it before attempting removal.`,
              )
          })
        } catch (error) {
          throw failure(
            `${diagnosis.message} Removal could not be confirmed: ${error instanceof Error ? error.message : "unknown error"}`,
          )
        }
      })
      return diagnosis
    }
  }
}

export type StateFileStore<T> = SealedStore<T> & {
  /** Returns the exact serialized credential written, for readback verification. Never log it. */
  readonly writeReturningText: (value: T) => Promise<string>
  readonly snapshot: (
    policy?: "ignore-refused",
    onRefused?: (clear: () => Promise<void>) => void,
  ) => Promise<{ text: string; version: string } | null>
  /** Private stored text, or null for a missing or refused file. */
  readonly text: () => Promise<string | null>
  /** True while any entry sits at the file's path, refused or not. */
  readonly present: () => Promise<boolean>
  readonly directory: () => string
}

export function createStateFileStore<T>(input: {
  readonly api: string
  readonly name: string
  /** The credential lock's home; the file sits beside the lock, so every process of this user meets on both. */
  readonly home?: string
  readonly codec: {
    readonly parse: (text: string) => T
    readonly serialize: (value: T) => string
    readonly amend?: (previous: string | null, next: T) => T
  }
  readonly failure: (message: string) => Error
  readonly log?: (line: string) => void
  /** The owning uid; undefined when the host has none to compare. Defaults to process.getuid. */
  readonly getuid?: () => number | undefined
}): StateFileStore<T> {
  const { api, name, codec, failure } = input
  const log = input.log ?? ((line: string) => process.stderr.write(`${line}\n`))
  const uid = (input.getuid ?? (() => process.getuid?.()))()
  const directory = () => stateFileDirectory(input.home ?? accountHome())
  const failed = (operation: string, error: unknown): Error =>
    error instanceof CredentialParentError
      ? failure(error.message)
      : error instanceof StateFileRefused
        ? failure(`omo: cannot ${operation} the private sign-in file in ${directory()}: ${error.message}.`)
        : failure(
            `omo: cannot ${operation} the private sign-in file in ${directory()} (${errnoCode(error) ?? "unknown"}).`,
          )
  const recoverOnAccess = async () => {
    const dir = directory()
    if ((await checkDir(dir, uid)) && (await readdir(dir)).some((entry) => isRetiring(entry, name))) {
      await locked(async () => {
        if (await checkDir(dir, uid)) await recoverRetiring(dir, name)
      })
    }
  }
  const text = async (): Promise<string | null> => {
    try {
      await recoverOnAccess()
      return (await readStateFile(directory(), name, uid))?.text ?? null
    } catch (error) {
      if (!(error instanceof StateFileRefused)) throw failed("read", error)
      log(`omo: ${error.message} in ${directory()} and is not used; this computer reads as signed out.`)
      return null
    }
  }
  const read = async (): Promise<T | null> => {
    const stored = await text()
    return stored === null ? null : codec.parse(stored)
  }
  const locked = <R>(action: () => Promise<R>): Promise<R> =>
    withCredentialLock(api, action, input.home ?? accountHome())
  const writeReturningText = (value: T) =>
    locked(async () => {
      const next = codec.amend === undefined ? value : codec.amend(await text(), value)
      const encoded = codec.serialize(next)
      try {
        await writeStateFile(directory(), name, encoded, uid, log)
        return encoded
      } catch (error) {
        throw failed("write", error)
      }
    })
  return {
    read,
    readAuthoritative: read,
    text,
    directory,
    snapshot: async (policy, onRefused) => {
      let diagnosis: Error | undefined
      try {
        await recoverOnAccess()
        if (onRefused && (await checkDir(directory(), uid))) {
          const refusal = await captureRefusedRemoval(directory(), name, uid, failure, onRefused)
          if (refusal) {
            diagnosis = refusal
            throw refusal
          }
        }
        return await readStateFile(directory(), name, uid)
      } catch (error) {
        if (
          (error instanceof CredentialParentError ||
            (error instanceof StateFileRefused && error.refusal.startsWith("dir-"))) &&
          onRefused
        ) {
          const precise = failure(error.message)
          onRefused(async () => {
            throw precise
          })
          throw precise
        }
        if (diagnosis) throw diagnosis
        if (policy === "ignore-refused" && error instanceof StateFileRefused) return null
        throw failed("read", error)
      }
    },
    present: async () => {
      try {
        await recoverOnAccess()
        await lstat(join(directory(), name))
        return true
      } catch (error) {
        if (errnoCode(error) === "ENOENT") return false
        throw failed("inspect", error)
      }
    },
    writeReturningText,
    write: async (value) => {
      await writeReturningText(value)
    },
    clear: () =>
      locked(async () => {
        try {
          if (await checkDir(directory(), uid)) await removeStateFile(directory(), name, uid)
        } catch (error) {
          throw failed("remove", error)
        }
      }),
  }
}
