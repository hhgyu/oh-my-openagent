import type { LockedStore } from "./keychain-helper/store-binding"
import { accountHome } from "./account-home"
import { withCredentialLock } from "./credential-lock"
import { CredentialStoreError, InvalidCredentialState, type CredentialStorage, type SealedStore } from "./keystore"
import type { StateFileStore } from "./state-file-store"

export type OpenKeyringState = "unlocked" | "absent" | "unknown"
/**
 * What the keyring holds next to a state file: nothing, the same sign-in with a token no fresher than the file's
 * ("older"), the same sign-in with a fresher token ("newer"), or another (or unreadable) sign-in.
 */
export type KeyringRelation = "empty" | "older" | "newer" | "other"

const LIBSECRET_NOTICE =
  "omo: could not check whether the keyring is locked (gdbus or the Secret Service did not answer); using libsecret directly."

/**
 * Where the shared Linux sign-in lives (#7185b): the Secret Service whenever one exists, the private state file only
 * when none is on the session bus (or Bun has no OS store). A probe that cannot answer keeps an existing file in use
 * and otherwise asks libsecret, as before. Once the Secret Service answers unlocked, a state file moves into it under
 * the credential lock, only over an empty slot or an older copy of the same sign-in, and is deleted only after the
 * keyring returned exactly what was written. "No Secret Service" is per process (cron, su, ssh with no session bus), so
 * a file can hold a sign-in written beside one the keyring already holds: that keyring sign-in is never replaced.
 */
export function routeLinuxStore<T>(input: {
  readonly api: string
  readonly home?: string
  readonly keyring: SealedStore<T>
  readonly file: StateFileStore<T>
  /** Throws for a locked keyring, which never falls back to the file. */
  readonly probe: () => Promise<OpenKeyringState>
  readonly keyringText: () => Promise<string | null>
  readonly parse: (text: string) => T
  readonly relation: (text: string) => Promise<KeyringRelation>
  /** Writes the stored text to the keyring and reads it back; throws, keeping the file, when either step fails. */
  readonly moveToKeyring: (text: string) => Promise<void>
  readonly writeKeyring: (value: T) => Promise<string>
  readonly notice: (message: string, purpose?: "probe" | "file" | "migration" | "retained") => void
}): SealedStore<T> {
  const { keyring, file, notice } = input
  let storage: CredentialStorage = "keyring"
  let libsecretNoticed = false
  let keptNoticed = false
  const underLock = (action: () => Promise<void>) => withCredentialLock(input.api, action, input.home ?? accountHome())
  const migrate = (keepSource: boolean) =>
    underLock(async () => {
      const text = await file.text()
      if (text === null) return
      const relation = await input.relation(text)
      if (relation === "empty" || relation === "older") {
        await input.moveToKeyring(text)
        if (!keepSource) await file.clear()
        return
      }
      if (keptNoticed) return
      keptNoticed = true
      notice(
        `omo: the keyring already holds ${relation === "newer" ? "a newer copy of this" : "another"} OmO sign-in, which stays in use; the private sign-in file in ${file.directory()} is left as it is.`,
        "migration",
      )
    })
  const choose = async (keepSource: boolean): Promise<CredentialStorage> => {
    const answer = await input.probe()
    if (answer === "absent") return "file"
    if (await file.present()) {
      if (answer === "unknown") return "file"
      await migrate(keepSource)
      return "keyring"
    }
    if (answer === "unknown" && !libsecretNoticed) {
      libsecretNoticed = true
      notice(LIBSECRET_NOTICE)
    }
    return "keyring"
  }
  const target = async (keepSource = false): Promise<SealedStore<T>> => {
    storage = await choose(keepSource)
    return storage === "file" ? file : keyring
  }
  const writeTo = async (store: SealedStore<T>, value: T) => {
    if (store === file)
      notice(
        `omo: An unlocked keyring could not be confirmed; OmO keeps this sign-in in a private file in ${file.directory()}, readable only by you. Start a keyring to keep it there instead.`,
        "file",
      )
    return store === file ? file.writeReturningText(value) : input.writeKeyring(value)
  }
  const clearKeyring = async (matchingVersion: string | undefined, retained: boolean) => {
    const verifyFile = async () => {
      const current = await file.snapshot()
      if (current === null) return false
      if (current.version !== matchingVersion)
        throw new CredentialStoreError("The private sign-in file changed during this operation. Try again.")
      return true
    }
    if (matchingVersion !== undefined) await verifyFile()
    await keyring.clear()
    if (matchingVersion !== undefined) {
      try {
        if (await verifyFile()) await file.clear()
      } catch {
        throw new CredentialStoreError(
          "The keyring sign-in was removed, but removal of the private sign-in file could not be confirmed.",
        )
      }
    } else if (retained) notice(`omo: the separate private sign-in file in ${file.directory()} was kept.`, "retained")
  }
  const clearFrom = async (store: SealedStore<T>) => {
    if (store !== keyring) return store.clear()
    const candidate = await file.snapshot("ignore-refused")
    const relation = candidate === null ? null : await input.relation(candidate.text)
    return clearKeyring(
      relation === "older" || relation === "newer" ? candidate?.version : undefined,
      candidate !== null,
    )
  }
  return {
    read: async () => (await target()).read(),
    readAuthoritative: async () => (await target()).readAuthoritative(),
    write: async (value) => {
      await writeTo(await target(), value)
    },
    clear: async () => clearFrom(await target(true)),
    async underLock(_lease, keepMigrationSource) {
      const selected = await target(keepMigrationSource)
      return lockedLinuxSelection({
        store: selected,
        parse: input.parse,
        snapshot: async () => {
          if (selected === file) return file.snapshot()
          const text = await input.keyringText()
          return text === null ? null : { text, version: text }
        },
        write: (value) => writeTo(selected, value),
        clear: () => clearFrom(selected),
        prepareCorruptClear: async (text) => {
          if (selected === file) return file.clear
          const candidate = await file.snapshot()
          const version = candidate?.text === text ? candidate.version : undefined
          return () => clearKeyring(version, candidate !== null)
        },
      })
    },
    storage: () => storage,
  }
}

export function lockedLinuxSelection<T>(input: {
  store: SealedStore<T>
  parse: (text: string) => T
  snapshot: () => Promise<{ text: string; version: string } | null>
  write: (value: T) => Promise<string>
  clear: () => Promise<void>
  prepareCorruptClear?: (text: string) => Promise<() => Promise<void>>
}): LockedStore<T> {
  let expected: string | undefined
  let corrupt: { version: string; clear: () => Promise<void> } | undefined
  let failed = false
  const changed = () => new CredentialStoreError("The selected sign-in could not be verified. Try again.")
  const read = async () => {
    if (failed) throw changed()
    failed = true
    const item = await input.snapshot()
    let value: T | null
    try {
      value = item === null ? null : input.parse(item.text)
    } catch (error) {
      if (expected === undefined && error instanceof InvalidCredentialState && item !== null)
        corrupt = { version: item.version, clear: (await input.prepareCorruptClear?.(item.text)) ?? input.store.clear }
      throw error
    }
    const observed = JSON.stringify(value)
    if (expected !== undefined && expected !== observed)
      throw new CredentialStoreError("The selected sign-in changed during this operation. Try again.")
    failed = false
    expected = observed
    return value
  }
  return {
    read,
    async write(value) {
      const firstMutation = expected === undefined && !failed
      try {
        await read()
      } catch (error) {
        if (!firstMutation || !(error instanceof InvalidCredentialState) || corrupt === undefined) throw error
        const { version } = corrupt
        corrupt = undefined
        if ((await input.snapshot())?.version !== version) throw changed()
      }
      failed = true
      const encoded = await input.write(value)
      // Storage may have assigned a generation to the write. The lease excludes other OmO writers.
      if ((await input.snapshot())?.text !== encoded) throw changed()
      expected = JSON.stringify(input.parse(encoded))
      failed = false
    },
    async clear() {
      if (corrupt !== undefined) {
        const { version, clear } = corrupt
        corrupt = undefined
        if ((await input.snapshot())?.version !== version) throw changed()
        await clear()
        return
      }
      await read()
      await input.clear()
      expected = "null"
    },
    recover: async () => {},
    settle: async () => {},
  }
}
