import { afterEach, describe, expect, test } from "bun:test"
import { generateKeyPairSync } from "node:crypto"
import { chmodSync, mkdirSync, mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { CredentialStore, Credentials } from "../../../cli/service-auth"
import {
  type FakeOwner,
  startFakeOwner,
} from "../../../../../device-service-core/test/local-api/conformance/fake-owner.ts"
import { defaultWorld } from "../../../../../device-service-core/test/local-api/conformance/world.ts"
import { hostAccountSource } from "./account-source"

// Design D r9 section 3 on the V2 sync host: the account source re-adopts into a running device service from the
// credential it already read for sync, and a sign-in the service ends on refresh makes the device service forget it.

const owners: FakeOwner[] = []
const servers: { stop(force?: boolean): unknown }[] = []
const dirs: string[] = []
afterEach(async () => {
  for (const owner of owners.splice(0)) await owner.stop()
  for (const server of servers.splice(0)) server.stop(true)
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function credentials(expiresInMs = 3_600_000): Credentials {
  return {
    accessToken: "access-1",
    accessTokenExpiresAt: new Date(Date.now() + expiresInMs).toISOString(),
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
}

function countingStore(initial: Credentials | null) {
  let value = initial
  const reads = { count: 0 }
  const store: CredentialStore = {
    read: async () => {
      reads.count += 1
      return value
    },
    readAuthoritative: async () => {
      reads.count += 1
      return value
    },
    write: async (next) => {
      value = next
    },
    clear: async () => {
      value = null
    },
  }
  return { store, reads }
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

function stateDirectory(): string {
  const dir = mkdtempSync(join(tmpdir(), "omo-v2-relay-"))
  chmodSync(dir, 0o700)
  dirs.push(dir)
  const stateDir = join(dir, "device-service")
  mkdirSync(stateDir, { recursive: true, mode: 0o700 })
  return stateDir
}

async function relayd(stateDir: string, adopted: boolean): Promise<FakeOwner> {
  const world = defaultWorld()
  const owner = await startFakeOwner({
    stateDir,
    world: adopted
      ? { ...world, service_version: "0.1.3" }
      : { ...world, service_version: "0.1.3", status: { ...world.status, device: null, state: "sign_in_required" } },
  })
  owners.push(owner)
  return owner
}

describe("the V2 sync host account source and the device service", () => {
  test("#given a running device service with no adopted device #when sync resolves the account twice #then one device.adopt carries the held account and no extra store read happens", async () => {
    // given
    const stored = credentials()
    const baseline = countingStore(stored)
    await hostAccountSource({
      api: "http://127.0.0.1:9",
      store: baseline.store,
      fetch: service,
      deviceServiceStateDir: stateDirectory(),
    })()
    const stateDir = stateDirectory()
    const owner = await relayd(stateDir, false)
    const instrumented = countingStore(stored)
    const source = hostAccountSource({
      api: "http://127.0.0.1:9",
      store: instrumented.store,
      fetch: service,
      deviceServiceStateDir: stateDir,
    })

    // when
    const account = await source()
    const readsAfterFirst = instrumented.reads.count
    await source()

    // then
    expect(account?.accountId).toBe("acct_42")
    expect(owner.state.log).toEqual(["status.get", "device.adopt"])
    expect(owner.state.adoptRequests.map((request) => request["account"])).toEqual(["acct_42"])
    expect(readsAfterFirst).toBe(baseline.reads.count)
  })

  test("#given a running device service that already adopted a device #when sync resolves the account #then nothing is adopted", async () => {
    // given
    const stateDir = stateDirectory()
    const owner = await relayd(stateDir, true)
    const { store } = countingStore(credentials())

    // when
    await hostAccountSource({ api: "http://127.0.0.1:9", store, fetch: service, deviceServiceStateDir: stateDir })()

    // then
    expect(owner.state.log).toEqual(["status.get"])
    expect(owner.state.adoptions).toBe(0)
  })

  test("#given the service ends the sign-in on refresh #when sync resolves the account #then the credential is cleared and the device service forgets the device", async () => {
    // given
    const stateDir = stateDirectory()
    const owner = await relayd(stateDir, true)
    const api = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: (request) =>
        new URL(request.url).pathname === "/v1/session/refresh"
          ? Response.json(
              { error: { code: "invalid_grant", message: "ended", retryable: false, requestId: "req-1" } },
              { status: 401 },
            )
          : new Response("{}", { status: 404 }),
    })
    servers.push(api)
    const { store } = countingStore(credentials(-60_000))

    // when
    const outcome = await hostAccountSource({
      api: `http://127.0.0.1:${api.port}`,
      store,
      fetch: service,
      deviceServiceStateDir: stateDir,
    })().then(
      () => "resolved",
      () => "ended",
    )

    // then
    expect(outcome).toBe("ended")
    expect(await store.read()).toBeNull()
    expect(owner.state.log).toEqual(["device.forget"])
  })
})
