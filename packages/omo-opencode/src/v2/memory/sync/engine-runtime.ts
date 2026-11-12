// The V2 engine chunk, the counterpart of Senpi's `#omo-memory-sync-runtime` sidecar. Only `./host.ts`
// reaches it, through `import()`: this is the one V2 module that names the memory-core sync engine, and
// with it the Loro wasm.

export {
  approveDevice, deviceKeyringFromMaterial, enableSync, GitSpaceConfig, joinAccount, listRemotes, openAccountSession, openDeviceSync, resolveSpace,
} from "@oh-my-opencode/memory-core/sync-engine"
export { failureRpcSync } from "./status-copy"
