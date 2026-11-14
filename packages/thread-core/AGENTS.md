# thread-core

Harness-neutral half of the cross-session thread tools, shared by the Senpi thread component
(`packages/omo-senpi/src/components/thread/`) and the OpenCode V2 host (`packages/omo-opencode/src/v2/threads/`).

## Contents

| Path | Purpose |
|------|---------|
| `errors.ts` | The thread failure taxonomy and `threadToolFailure`. |
| `contracts/` | TypeBox parameter schemas, byte limits, result unions and `parseThreadParams` for the eighteen `thread_*` tools. |
| `metadata.ts` | Tool metadata (eval-only exposure) and the family prompt guideline. |
| `addressing.ts` | `resolveTarget`, fuzzy match, name normalization and workspace scope. |
| `thread-link.ts` | The `omo-thread://v1/<thread_id>` link format. |
| `caller.ts` | `UNKNOWN_CALLER`. |
| `remote/ports.ts` | Types of the other-device surface a host may supply. |
| `gateway/` | The session gateway: SQLite store (worker thread `store-worker.ts`), sender engine, receiver inbox drain, the delivery decision table, bindings/outbox/relay, completion arms, provenance, process identity. |
| `gateway-replies.ts` | Parsers of an endpoint's `wake` / `release_session` replies. |

The behavior contract of every module is documented in
[`packages/omo-senpi/src/components/thread/AGENTS.md`](../omo-senpi/src/components/thread/AGENTS.md); the paths it names
under `gateway/`, `contracts/`, `errors.ts`, `addressing.ts`, `metadata.ts` and `thread-link.ts` live here.

## Rules

- No host imports: nothing here imports `@code-yeongyu/senpi`, `@opencode/*` or an adapter package. A host reaches
  its sessions through the ports in `gateway/adapter.ts` (`GatewayEndpointPort` sender side, `SessionRuntimePort`
  receiver side).
- The store worker is started by URL (`gateway/store.ts` `gatewayStoreWorkerUrl`, or the `workerUrl` option); a
  bundling host emits `gateway/store-worker.ts` as its own file.
