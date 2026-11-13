import { describe, expect, test } from "bun:test"
import { generateKeyPairSync } from "node:crypto"
import { mkdirSync, utimesSync, writeFileSync } from "node:fs"
import type { CredentialStore, Credentials } from "../../../cli/service-auth"
import { credentialLockPaths, withCredentialLock } from "../../../cli/service-auth/credential-lock"
import { hostAccountSource } from "./account-source"

// #12978 / #12989 on the V2 sync host: its account source names no lock home, so it meets `omo login` and every other
// process of this OS user on the one per-origin credential lock, and a torn lock record does not block it.

const stored: Credentials = {
  accessToken: "access-1",
  accessTokenExpiresAt: new Date(Date.now() + 3_600_000).toISOString(),
  refreshToken: "refresh-1",
  device: { id: "dev_service_row", name: "laptop" },
  signingPrivateKey: generateKeyPairSync("ed25519")
    .privateKey.export({ format: "der", type: "pkcs8" })
    .toString("base64"),
  sealingPrivateKey: generateKeyPairSync("x25519")
    .privateKey.export({ format: "der", type: "pkcs8" })
    .toString("base64"),
  accountId: "acct_42",
  credentialGeneration: "gen-a",
}

const store: CredentialStore = {
  read: async () => stored,
  readAuthoritative: async () => stored,
  write: async () => undefined,
  clear: async () => undefined,
}

const service: typeof fetch = Object.assign(
  async (input: Parameters<typeof fetch>[0]) => {
    if (String(input).endsWith("/v1/devices"))
      return Response.json({ devices: [{ id: "dev_service_row", current: true, revokedAt: null }] })
    if (String(input).endsWith("/v1/me")) return Response.json({ user: { id: "u" }, account: { id: "acct_42" } })
    return new Response("{}", { status: 404 })
  },
  { preconnect: fetch.preconnect },
)

const noRelay = { readopt: async () => true, forget: async () => undefined }

describe("the V2 sync host and the per-OS-user credential lock", () => {
  test("#given another process of this OS user holds the credential lock #when the V2 host resolves the account #then it waits for that holder", async () => {
    // given
    const api = "http://127.0.0.1:19"
    const order: string[] = []
    let release: () => void = () => undefined
    let taken: () => void = () => undefined
    const lockTaken = new Promise<void>((resolve) => {
      taken = resolve
    })
    const holder = withCredentialLock(api, async () => {
      taken()
      await new Promise<void>((resolve) => {
        release = resolve
      })
      order.push("holder released")
    })
    await lockTaken

    // when
    const resolving = hostAccountSource({ api, store, fetch: service, relay: noRelay })().then((account) => {
      order.push("resolved")
      return account
    })
    await Bun.sleep(300)
    const beforeRelease = [...order]
    release()
    const account = await resolving
    await holder

    // then
    expect(beforeRelease).toEqual([])
    expect(order).toEqual(["holder released", "resolved"])
    expect(account?.accountId).toBe("acct_42")
  }, 20_000)

  test("#given a lock record torn by a crash an hour ago #when the V2 host resolves the account #then the record is reclaimed at once", async () => {
    // given
    const api = "http://127.0.0.1:29"
    const { directory, lock } = credentialLockPaths(api)
    mkdirSync(directory, { recursive: true })
    writeFileSync(lock, "")
    const anHourAgo = new Date(Date.now() - 3_600_000)
    utimesSync(lock, anHourAgo, anHourAgo)

    // when
    const started = performance.now()
    const account = await hostAccountSource({ api, store, fetch: service, relay: noRelay })()

    // then
    expect(account?.accountId).toBe("acct_42")
    expect(performance.now() - started).toBeLessThan(5_000)
  }, 20_000)
})
