// The CLI DeviceAccountSource: the signed-in device from the service-auth credential store. The
// account types it returns live in memory-core's sync runner, with the resolver that consumes them.

import {
  CredentialIdentityChanged,
  type Credentials,
  createCredentialStore,
  type CredentialStore,
  createSession,
  currentServiceDevice,
  retireSyncPinOnDiscard,
  KeychainApprovalPendingError,
  quietNotice,
  serviceOrigin,
  SignInError,
} from "@oh-my-opencode/omo-opencode/service-auth"
import { randomUUID } from "node:crypto"
import { deviceKeyringFromMaterial } from "@oh-my-opencode/memory-core/sync-account-ports"
import { cliAccountOperation, scopedCliKeyring } from "./cli-account-operation"

import type { DesktopSyncDescriptor, SyncOperationAuthority } from "@oh-my-opencode/memory-core/sync-engine"
import { SyncConfigError, SyncSessionDeferredError, type CliDeviceAccount } from "@oh-my-opencode/memory-core/sync-runner"

export type { CliDeviceAccount, DesktopSyncUnavailable, DeviceAccount, DeviceAccountSource, KeyringFactory } from "@oh-my-opencode/memory-core/sync-runner"
export type { DesktopSyncDescriptor, SyncDevice, SyncOperationAuthority, DesktopSyncOperation, DesktopSyncAccount } from "@oh-my-opencode/memory-core/sync-engine"

export const DEFAULT_SERVICE_API = "https://api.omo.dev"

const base64url = (base64: string): string => Buffer.from(base64, "base64").toString("base64url")

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value)

async function accountIdOf(api: string, token: string, doFetch: typeof fetch): Promise<string> {
  const response = await doFetch(`${api}/v1/me`, { headers: { authorization: `Bearer ${token}` } })
  if (!response.ok) throw new Error(`memory sync: the account read failed (${response.status})`)
  const body: unknown = await response.json()
  const account = isRecord(body) ? body["account"] : undefined
  const id = isRecord(account) ? account["id"] : undefined
  if (typeof id !== "string" || id === "") throw new Error("memory sync: the account read named no account")
  return id
}

/** The service device this token authenticates: the one row the device list marks current. */
async function currentDeviceOf(api: string, token: string, doFetch: typeof fetch): Promise<string | null> {
  const response = await doFetch(`${api}/v1/devices`, { headers: { authorization: `Bearer ${token}` } })
  if (!response.ok) throw new Error(`memory sync: the device read failed (${response.status})`)
  return currentServiceDevice(await response.json())
}

const sameKeys = (a: Credentials, b: Credentials): boolean => a.device.id === b.device.id
  && a.signingPrivateKey === b.signingPrivateKey && a.sealingPrivateKey === b.sealingPrivateKey

export function createCliAccountSource(options: {
  readonly api?: string
  readonly env?: Record<string, string | undefined>
  readonly store?: CredentialStore
  readonly fetch?: typeof fetch
  readonly home?: string
  /** This host's trust-pin directory: a pin is retired when the keys that earned it are discarded (#12280); absent, none is. */
  readonly pinDir?: string
  /** The host's logger: one warning per pin a discard could not retire. */
  readonly logger?: { warn(line: string): void }
}): () => Promise<CliDeviceAccount | null> {
  const configured = options.api === undefined ? options.env?.OMO_SERVICE_API_URL : undefined
  let api: string
  try {
    api = serviceOrigin(options.api ?? configured ?? DEFAULT_SERVICE_API)
  } catch (error) {
    if (configured !== undefined) throw new SyncConfigError("OMO_SERVICE_API_URL", error)
    throw error
  }
  const doFetch = options.fetch ?? fetch
  const pinDir = options.pinDir
  const beforeKeysDiscarded = pinDir === undefined ? async () => undefined
    : retireSyncPinOnDiscard({ pinDir: () => pinDir, log: (line) => options.logger?.warn(line) })
  let active: { readonly generation: string; readonly abort: AbortController } | undefined
  // A keychain waiting for its approval dialog is not a signed-out device: sync defers this pass and retries.
  return async () => {
    try {
      return await resolve()
    } catch (error) {
      if (error instanceof KeychainApprovalPendingError) throw new SyncSessionDeferredError(error.message, error)
      throw error
    }
  }
  async function resolve(): Promise<CliDeviceAccount | null> {
    let store: CredentialStore
    let credentials: Credentials | null
    try {
      // A host runs under a TUI: the CLI's keyring-fallback notice must not write over it, and the fallback is
      // the same libsecret path the CLI uses (#10658 review).
      store = options.store ?? createCredentialStore(api, { notice: quietNotice, ...(options.home === undefined ? {} : { home: options.home }) })
      credentials = await store.read()
    } catch (error) {
      if (error instanceof KeychainApprovalPendingError) throw error
      // A host with no usable OS credential store (plain Node, a locked or absent keyring) cannot be
      // signed in; that is the signed-out state, not a sync failure on every session bind.
      if (error instanceof SignInError) return null
      throw error
    }
    if (credentials === null) { active?.abort.abort(); active = undefined; return null }
    const session = createSession({
      api, store, ...(options.home === undefined ? {} : { home: options.home }),
      beforeKeysDiscarded,
    })
    // One credential transaction captures a concrete generation before the first token or identity await: a legacy
    // credential is stamped and re-read under the lock, so an absent generation is never a wildcard afterwards.
    const initial = await session.update(async current => {
      if (current === null || current.credentialGeneration !== undefined) return current
      await store.write({ ...current, credentialGeneration: randomUUID() })
      return store.readAuthoritative()
    })
    if (initial === null || initial.credentialGeneration === undefined) return null
    const generation = initial.credentialGeneration
    const sameGeneration = (current: Credentials): boolean => sameKeys(current, initial) && current.credentialGeneration === generation
    let accountId: string
    try {
      const token = await session.accessToken(sameGeneration)
      accountId = await accountIdOf(api, token, doFetch)
      // The token must authenticate the captured device; another generation's reply is discarded, never persisted.
      if (await currentDeviceOf(api, token, doFetch) !== initial.device.id) return null
    } catch (error) {
      if (error instanceof CredentialIdentityChanged) return null
      throw error
    }
    credentials = await session.update(async current => {
      if (current === null || !sameGeneration(current)) return null
      if (current.accountId === accountId) return current
      if (current.accountId !== undefined) return null
      await store.write({ ...current, accountId })
      return store.readAuthoritative()
    })
    if (credentials === null || credentials.credentialGeneration !== generation || credentials.accountId !== accountId) return null
    const captured = credentials
    // A refusal aborts only the operations that saw it: a capture that re-reads the same generation and keys under the
    // lock gets a live controller, so one transiently empty read never leaves sync off until restart (#11812).
    if (active?.generation !== generation || active.abort.signal.aborted) {
      active?.abort.abort()
      active = { generation, abort: new AbortController() }
    }
    const abort = active.abort
    const sameCaptured = (current: Credentials | null): boolean => current !== null && current.accountId === accountId
      && current.credentialGeneration === generation && sameKeys(current, captured)
    const isCurrent = async (): Promise<boolean> => {
      if (abort.signal.aborted) return false
      const current = await session.update(async stored => stored)
      const same = sameCaptured(current)
      if (!same) abort.abort()
      return same && !abort.signal.aborted
    }
    const boundary = async <T>(dispatch: () => T): Promise<T> => {
      const result = await session.update(current => {
        if (abort.signal.aborted || !sameCaptured(current)) {
          abort.abort()
          throw new Error("The CLI sync account is no longer current.")
        }
        // Box the return value: release the lock after dispatch itself, not an in-flight request.
        return Promise.resolve({ value: dispatch() })
      })
      return result.value
    }
    const check = async () => { if (!await isCurrent()) throw new Error("The CLI sync account is no longer current.") }
    const accessToken = async () => {
      await check()
      let token: string
      try {
        token = await session.accessToken(sameCaptured)
      } catch (error) {
        if (error instanceof CredentialIdentityChanged) abort.abort()
        throw error
      }
      await check()
      return token
    }
    const material = { signingPrivatePkcs8: base64url(captured.signingPrivateKey), sealingPrivatePkcs8: base64url(captured.sealingPrivateKey) }
    const raw = await deviceKeyringFromMaterial(material)
    await check()
    const descriptor: DesktopSyncDescriptor = {
      genesis: "unsupported", rpId: null, userName: null,
      serviceOrigin: api, accountId, serviceDeviceId: captured.device.id,
      syncPrincipalId: raw.principal().id, publicKeys: raw.publicKeys(), generation, incarnation: "cli",
    }
    const authority: SyncOperationAuthority = {
      signal: abort.signal,
      admit: effect => { abort.signal.throwIfAborted(); return effect() },
    }
    return {
      kind: "cli",
      descriptor,
      signal: abort.signal,
      boundary,
      forOperation: owner => cliAccountOperation({ descriptor, lifetime: abort.signal, isCurrent, boundary, accessToken, keyring: raw, fetch: doFetch }, owner),
      api,
      accountId,
      serviceDeviceId: captured.device.id,
      keyring: async build => { await check(); const keyring = await build(material); await check(); return scopedCliKeyring(keyring, check, authority, boundary) },
      accessToken,
      isCurrent,
      signedOut: async () => {
        try {
          return (await store.read()) === null
        } catch (error) {
          if (error instanceof KeychainApprovalPendingError) return false
          throw error
        }
      },
    }
  }
}
