import { afterEach, expect, test } from "bun:test"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { buildIdentityPaths } from "@oh-my-opencode/memory-core"
import {
  SYNC_CONFIG_INVALID,
  SYNC_UNAVAILABLE,
  createDeviceSessionResolver,
  createSyncRunner,
} from "@oh-my-opencode/memory-core/sync-runner"

import { selectedDeviceAccountSource } from "./device-session/account-runtime-loader"

const dirs: string[] = []
afterEach(async () => {
  for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true })
})

async function identity() {
  const root = await mkdtemp(join(tmpdir(), "omo-sync-runner-"))
  dirs.push(root)
  const paths = buildIdentityPaths(root, "agent")
  await mkdir(join(paths.repo, ".git", "logs"), { recursive: true })
  await writeFile(join(paths.repo, ".git", "logs", "HEAD"), "")
  return paths
}

const loadRuntime = () => import("#omo-memory-sync-runtime")

test("an unloadable device account sidecar reports sync-unavailable with its reason, like the engine sidecar", async () => {
  const paths = await identity()
  const warned: { message: string; code: unknown }[] = []
  const errors: string[] = []
  const missing = Object.assign(new Error("Cannot find module '#omo-device-account-runtime'"), {
    code: "ERR_MODULE_NOT_FOUND",
  })
  const runner = createSyncRunner({
    loadRuntime,
    logger: {
      info: () => undefined,
      warn: (message: string, meta?: Record<string, unknown>) => warned.push({ message, code: meta?.code }),
      error: (message: string) => errors.push(message),
    },
    resolveSession: createDeviceSessionResolver({
      source: selectedDeviceAccountSource({ env: {} }, async () => {
        throw missing
      }),
      pinDir: join(paths.runtime, "pins"),
      loadRuntime: () => Promise.reject(new Error("the engine sidecar is not reached when the account cannot load")),
    }),
    watchHead: () => () => undefined,
  })
  await runner.acquire("agent", paths, { enabled: true })
  const status = await runner.status(paths.repo)
  expect(status?.kind).toBe(SYNC_UNAVAILABLE)
  expect(status !== null && "reason" in status ? status.reason : "").toContain("#omo-device-account-runtime")
  expect(warned.map((w) => w.code)).toEqual([SYNC_UNAVAILABLE])
  expect(errors).toEqual([])
  await runner.release(paths.repo)
})

test("an invalid OMO_SERVICE_API_URL is reported as a configuration error naming the variable, not as an unavailable sidecar", async () => {
  const paths = await identity()
  const warned: unknown[] = []
  const errors: { message: string; code: unknown; variable: unknown }[] = []
  const runner = createSyncRunner({
    loadRuntime,
    logger: {
      info: () => undefined,
      warn: (_message: string, meta?: Record<string, unknown>) => warned.push(meta?.code),
      error: (message: string, meta?: Record<string, unknown>) =>
        errors.push({ message, code: meta?.code, variable: meta?.variable }),
    },
    resolveSession: createDeviceSessionResolver({
      source: selectedDeviceAccountSource({ env: { OMO_SERVICE_API_URL: "not a url" } }),
      pinDir: join(paths.runtime, "pins"),
      loadRuntime: () =>
        Promise.reject(new Error("the engine sidecar is not reached when the account cannot be built")),
    }),
    watchHead: () => () => undefined,
  })
  await runner.acquire("agent", paths, { enabled: true })
  const status = await runner.status(paths.repo)
  expect(status?.kind).toBe(SYNC_CONFIG_INVALID)
  expect(status !== null && "variable" in status ? status.variable : undefined).toBe("OMO_SERVICE_API_URL")
  expect(warned).toEqual([])
  expect(errors).toHaveLength(1)
  expect(errors[0]?.code).toBe(SYNC_CONFIG_INVALID)
  expect(errors[0]?.variable).toBe("OMO_SERVICE_API_URL")
  expect(errors[0]?.message).toContain("OMO_SERVICE_API_URL")
  expect(errors[0]?.message).not.toContain("sidecar")
  await runner.release(paths.repo)
})
