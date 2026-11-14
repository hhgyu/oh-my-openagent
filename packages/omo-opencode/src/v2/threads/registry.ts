import { randomBytes, timingSafeEqual } from "node:crypto"
import { chmodSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { gatewayRootDirectory } from "@oh-my-opencode/thread-core/gateway/paths"
import { isClaimantDead } from "@oh-my-opencode/thread-core/gateway/process-identity"

export const ENDPOINT_REGISTRY_VERSION = 1

export type V2Endpoint = {
  readonly version: typeof ENDPOINT_REGISTRY_VERSION
  readonly instance_id: string
  readonly pid: number
  readonly socket: string
  readonly url: string
  readonly secret: string
  readonly directory: string
  readonly created_at: number
}

export function endpointRegistryDirectory(agentDir: string): string {
  return join(gatewayRootDirectory(agentDir), "opencode-v2-endpoints")
}

const SAFE_ID = /^[A-Za-z0-9-]{8,64}$/

export function newEndpointSecret(): string {
  return randomBytes(32).toString("hex")
}

export function secretMatches(expected: string, given: string | undefined): boolean {
  if (given === undefined) return false
  const left = Buffer.from(expected)
  const right = Buffer.from(given)
  return left.length === right.length && timingSafeEqual(left, right)
}

function parse(raw: string): V2Endpoint | undefined {
  let value: unknown
  try {
    value = JSON.parse(raw)
  } catch {
    return undefined
  }
  if (typeof value !== "object" || value === null) return undefined
  const entry = value as Record<string, unknown>
  if (
    entry["version"] !== ENDPOINT_REGISTRY_VERSION ||
    typeof entry["instance_id"] !== "string" ||
    !SAFE_ID.test(entry["instance_id"]) ||
    typeof entry["pid"] !== "number" ||
    !Number.isSafeInteger(entry["pid"]) ||
    typeof entry["socket"] !== "string" ||
    typeof entry["url"] !== "string" ||
    !/^http:\/\/127\.0\.0\.1:\d{1,5}$/.test(entry["url"]) ||
    typeof entry["secret"] !== "string" ||
    typeof entry["directory"] !== "string" ||
    typeof entry["created_at"] !== "number"
  )
    return undefined
  return entry as V2Endpoint
}

/**
 * The omo-owned registry of live OpenCode 2 thread endpoints for one agent dir. Each server writes one 0600 file
 * (temp + rename) at start and removes it at close. A reader skips its own entry and every entry whose process is
 * gone, deleting the dead one's file, so a crashed server leaves nothing addressable behind.
 */
export function createEndpointRegistry(agentDir: string) {
  const directory = endpointRegistryDirectory(agentDir)
  const pathOf = (instanceId: string) => join(directory, `${instanceId}.json`)

  return {
    directory,
    publish(entry: V2Endpoint): void {
      if (!SAFE_ID.test(entry.instance_id)) throw Error(`invalid endpoint instance id ${entry.instance_id}`)
      mkdirSync(directory, { recursive: true, mode: 0o700 })
      const target = pathOf(entry.instance_id)
      const temporary = `${target}.${process.pid}.tmp`
      writeFileSync(temporary, JSON.stringify(entry), { mode: 0o600 })
      chmodSync(temporary, 0o600)
      renameSync(temporary, target)
    },
    withdraw(instanceId: string): void {
      rmSync(pathOf(instanceId), { force: true })
    },
    async live(selfInstanceId: string): Promise<{ readonly endpoints: V2Endpoint[]; readonly removed: string[] }> {
      let names: string[]
      try {
        names = readdirSync(directory)
      } catch {
        return { endpoints: [], removed: [] }
      }
      const endpoints: V2Endpoint[] = []
      const removed: string[] = []
      for (const name of names) {
        if (!name.endsWith(".json")) continue
        let raw: string
        try {
          raw = readFileSync(join(directory, name), "utf8")
        } catch {
          continue
        }
        const entry = parse(raw)
        if (entry === undefined || `${entry.instance_id}.json` !== name || entry.instance_id === selfInstanceId)
          continue
        const dead = await isClaimantDead({
          pid: entry.pid,
          process_start_time: null,
          instance_id: entry.instance_id,
          runtime_instance: null,
        })
        if (dead) {
          rmSync(join(directory, name), { force: true })
          removed.push(entry.instance_id)
          continue
        }
        endpoints.push(entry)
      }
      return { endpoints, removed }
    },
  }
}

export type EndpointRegistry = ReturnType<typeof createEndpointRegistry>
