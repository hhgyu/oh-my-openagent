// The lazily loaded V2 sync host (imported only by `./runtime.ts` through `import()`). It wires the
// host-neutral memory-core runner, device-session resolver and `omo.memory.sync` coordinator (S8a) to
// the CLI account source both hosts share (`cli/service-auth/sync-account`), the cross-process RPC
// claims and a HEAD watch that also reports converges. The Loro engine loads one step later, from
// `./engine-runtime`, only once a device has an account session or a ceremony starts.

import { dirname, join } from "node:path"
import { syncPinDir } from "@oh-my-opencode/memory-core"
import {
  createDeviceSessionResolver,
  createSyncRunner,
  registerSyncRpc,
  type DeviceAccountSource,
  type SyncRpcAccount,
  type SyncRpcRegistration,
} from "@oh-my-opencode/memory-core/sync-runner"
import { createCliAccountSource } from "../../../cli/service-auth/sync-account"
import { createSyncRpcClaims } from "./claims"
import { watchHeadLog } from "./head-watch"
import { runnerLogger, type SyncHost, type SyncHostOptions } from "./ports"
import { readRpcSync } from "./status-field"

type Handler = Parameters<SyncRpcRegistration["handle"]>[1]

const loadEngine = () => import("./engine-runtime")

export function createSyncHost(options: SyncHostOptions): SyncHost {
  const pinDir = syncPinDir(options.memoryRoot)
  const logger = runnerLogger(options.logger)
  // Built on the first resolve, so an invalid OMO_SERVICE_API_URL reaches the runner as a typed
  // `sync-config-invalid` status instead of failing the host load.
  let built: DeviceAccountSource | undefined
  const source: DeviceAccountSource =
    options.source ??
    (async () => {
      built ??= createCliAccountSource({
        env: options.env,
        pinDir,
        logger: { warn: (line) => options.logger.warn(line) },
      })
      return built()
    })
  const runner = createSyncRunner({
    logger,
    loadRuntime: loadEngine,
    onStatusChange: options.onStatusChange,
    watchHead: (gitDir, onChange, warn) =>
      watchHeadLog(
        gitDir,
        () => {
          onChange()
          options.onHeadChange(dirname(gitDir))
        },
        warn,
      ),
    resolveSession: createDeviceSessionResolver({ source, pinDir, loadRuntime: loadEngine }),
  })
  const handlers = new Map<string, Handler>()
  const coordinator = registerSyncRpc(
    {
      handle: (name, handler) => {
        handlers.set(name, handler)
      },
    },
    {
      source: async (): Promise<SyncRpcAccount | null> => {
        const account = await source()
        // Only an operation-capable account may run a ceremony; there is no credential fallback.
        return account !== null && "descriptor" in account && "forOperation" in account ? account : null
      },
      runtime: {
        enableSync: async (input) => (await loadEngine()).enableSync(input),
        joinAccount: async (input) => (await loadEngine()).joinAccount(input),
        approveDevice: async (input) => (await loadEngine()).approveDevice(input),
      },
      claims: createSyncRpcClaims(join(options.memoryRoot, "runtime", "sync-rpc-claims")),
      pinDir,
      signal: options.signal,
      syncStatus: options.syncStatus,
      enabled: options.enabled,
    },
  )
  return {
    acquire: (identity, paths, space) => runner.acquire(identity, paths, { enabled: true }, space),
    release: (repo) => runner.release(repo),
    rpcSync: (repo) =>
      readRpcSync(
        () => runner.status(repo),
        async (status) => (await loadEngine()).failureRpcSync(status),
      ),
    async call(verb, data, owner) {
      const handler = handlers.get(`omo.memory.sync.${verb}`)
      if (handler === undefined) return { kind: "unavailable", reason: "Unknown memory sync operation." }
      return handler(data, owner)
    },
    dispose: () => coordinator.dispose(),
  }
}
