import { accountHome } from "./account-home"
import { withCredentialLock } from "./credential-lock"
import { CredentialStoreError, type CredentialStorage, type SealedStore } from "./keystore"
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
  readonly relation: (text: string) => Promise<KeyringRelation>
  /** Writes the stored text to the keyring and reads it back; throws, keeping the file, when either step fails. */
  readonly moveToKeyring: (text: string) => Promise<void>
  readonly matchesWrite: (stored: T, intended: T) => boolean
  readonly notice: (message: string) => void
}): SealedStore<T> {
  const { keyring, file, notice } = input
  let storage: CredentialStorage = "keyring"
  let libsecretNoticed = false
  let keptNoticed = false
  const underLock = (action: () => Promise<void>) => withCredentialLock(input.api, action, input.home ?? accountHome())
  const migrate = () =>
    underLock(async () => {
      const text = await file.text()
      if (text === null) return
      const relation = await input.relation(text)
      if (relation === "empty" || relation === "older") {
        await input.moveToKeyring(text)
        await file.clear()
        return
      }
      if (keptNoticed) return
      keptNoticed = true
      notice(
        `omo: the keyring already holds ${relation === "newer" ? "a newer copy of this" : "another"} OmO sign-in, which stays in use; the private sign-in file in ${file.directory()} is left as it is.`,
      )
    })
  const choose = async (): Promise<CredentialStorage> => {
    const answer = await input.probe()
    if (answer === "absent") return "file"
    if (await file.present()) {
      if (answer === "unknown") return "file"
      await migrate()
      return "keyring"
    }
    if (answer === "unknown" && !libsecretNoticed) {
      libsecretNoticed = true
      notice(LIBSECRET_NOTICE)
    }
    return "keyring"
  }
  const target = async (): Promise<SealedStore<T>> => {
    storage = await choose()
    return storage === "file" ? file : keyring
  }
  const writeTo = async (store: SealedStore<T>, value: T) => {
    if (store === file)
      notice(
        `omo: No keyring is running; OmO keeps this sign-in in a private file in ${file.directory()}, readable only by you. Start a keyring to keep it there instead.`,
      )
    await store.write(value)
  }
  const clearFrom = async (store: SealedStore<T>) => {
    if (store === keyring) {
      const text = await file.text()
      if (text !== null) {
        const relation = await input.relation(text)
        if (relation === "older" || relation === "newer") await file.clear()
      }
    }
    await store.clear()
  }
  return {
    read: async () => (await target()).read(),
    readAuthoritative: async () => (await target()).readAuthoritative(),
    write: async (value) => writeTo(await target(), value),
    clear: async () => clearFrom(await target()),
    async underLock() {
      const selected = await target()
      let expected: string | undefined
      let failed = false
      const changed = () => new CredentialStoreError("The selected sign-in could not be verified. Try again.")
      const read = async () => {
        if (failed) throw changed()
        failed = true
        const value = await selected.readAuthoritative()
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
          await read()
          failed = true
          await writeTo(selected, value)
          // Storage may have assigned a generation to the write. The lease excludes other OmO writers.
          const written = await selected.readAuthoritative()
          if (written === null || !input.matchesWrite(written, value)) throw changed()
          expected = JSON.stringify(written)
          failed = false
        },
        async clear() {
          await read()
          await clearFrom(selected)
          expected = "null"
        },
        recover: async () => {},
        settle: async () => {},
      }
    },
    storage: () => storage,
  }
}
