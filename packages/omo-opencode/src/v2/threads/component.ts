// The eighteen Native `thread_*` tools on the OpenCode 2 host, eval-only as in Native (63b61a4115): they are owned eval
// host tools (`tools.thread_send(...)` inside a cell), never direct model tools. The gateway (store, engine, drain,
// relay) is the shared `@oh-my-opencode/thread-core` copy; this directory only adapts OpenCode sessions to its ports.

import { existsSync } from "node:fs"
import { randomUUID } from "node:crypto"
import { fileURLToPath } from "node:url"
import { resolveAgentHome } from "@oh-my-opencode/senpi-task/agent-home"
import { createCompletionTracker, type AgentEndFacts } from "@oh-my-opencode/thread-core/gateway/completion"
import type { CompletionOutcome } from "@oh-my-opencode/thread-core/gateway/bindings"
import { createGatewayEngine, resolveFromEntries } from "@oh-my-opencode/thread-core/gateway/engine"
import { createLocalTransport } from "@oh-my-opencode/thread-core/gateway/local-transport"
import { gatewayDatabasePath } from "@oh-my-opencode/thread-core/gateway/paths"
import { resolveProvenance } from "@oh-my-opencode/thread-core/gateway/provenance-resolver"
import { createGatewayRelay } from "@oh-my-opencode/thread-core/gateway/relay"
import { createGatewayStore, type GatewayStore } from "@oh-my-opencode/thread-core/gateway/store"
import type { OwnedEvalHostTool } from "../tools/codemode-host-tools"
import { addressEntry, endpointRef, listAddressEntries, type V2AddressEntry } from "./address-book"
import { createThreadDrains } from "./drains"
import { THREAD_CLOSED_METADATA_KEY, isClosed, writeSessionMetadata, type ControlHost, type ThreadV2Host } from "./host"
import { createPeerClient, startPeerServer, type PeerClient } from "./peer"
import { ENDPOINT_REGISTRY_VERSION, createEndpointRegistry, newEndpointSecret } from "./registry"
import { createSessionStateTracker } from "./session-state"
import type { ThreadSurface } from "./surface"
import { createThreadHostTools, type ThreadCallFactory } from "./tools"

export const THREAD_REPLY_METADATA_KEY = "omoThreadReplyAllowed"

export type ThreadComponentOptions = {
  readonly agentDir?: string
  readonly env?: Readonly<Record<string, string | undefined>>
  /** Tests inject a store; production opens `<agent dir>/gateway/gateway.sqlite`, the store Native threads use. */
  readonly store?: GatewayStore
}

export type ThreadComponent = {
  readonly tools: readonly OwnedEvalHostTool[]
  readonly socket: string
  readonly start: () => Promise<void>
  readonly close: () => Promise<void>
}

/** The store worker the V2 bundle emits beside its chunks; from source the store resolves `store-worker.ts` itself. */
function bundledWorkerUrl(): URL | undefined {
  const url = new URL("./store-worker.js", import.meta.url)
  return url.protocol === "file:" && existsSync(fileURLToPath(url)) ? url : undefined
}

function endFacts(outcome: CompletionOutcome): AgentEndFacts {
  if (outcome === "cancelled") return { aborted: true }
  return outcome === "failed" ? { messages: [{ role: "assistant", stopReason: "error" }] } : {}
}

export function createThreadComponent(host: ThreadV2Host, options: ThreadComponentOptions = {}): ThreadComponent {
  const env = options.env ?? process.env
  const agentDir = options.agentDir ?? resolveAgentHome({ env })
  const socket = `opencode-v2:${process.pid}:${randomUUID()}`
  const log = (line: string) => console.warn(`[oh-my-openagent/v2] thread gateway: ${line}`)
  const workerUrl = bundledWorkerUrl()
  const store = options.store ?? createGatewayStore({ agentDir, ...(workerUrl === undefined ? {} : { workerUrl }) })
  const senderProvenance = () => resolveProvenance({ cwd: host.location.directory, env })
  const tracker = createSessionStateTracker(host)
  const instanceId = randomUUID()
  const registry = createEndpointRegistry(agentDir)
  const secret = newEndpointSecret()
  const peers = new Map<string, PeerClient>()
  const drains = createThreadDrains({
    store,
    host,
    snapshot: tracker.snapshot,
    socket,
    log,
    peerOf: (peerSocket) => peers.get(peerSocket),
  })
  /** This server's sessions, then every live peer server's; a peer that does not answer is left out of this view. */
  async function entries(): Promise<V2AddressEntry[]> {
    const local = await listAddressEntries(host.session, socket)
    const { endpoints, removed } = await registry.live(instanceId)
    for (const id of removed) log(`removed the registry entry of dead OpenCode 2 server ${id}`)
    for (const [peerSocket, peer] of peers)
      if (!endpoints.some((endpoint) => endpoint.socket === peerSocket && endpoint.secret === peer.endpoint.secret))
        peers.delete(peerSocket)
    const remote = await Promise.all(
      endpoints.map(async (endpoint) => {
        const peer = peers.get(endpoint.socket) ?? createPeerClient(endpoint)
        try {
          const sessions = await peer.list()
          peers.set(endpoint.socket, peer)
          return sessions.map((info) => addressEntry(info, endpoint.socket))
        } catch (error) {
          log(
            `OpenCode 2 server ${endpoint.instance_id} did not answer: ${error instanceof Error ? error.message : String(error)}`,
          )
          return []
        }
      }),
    )
    const seen = new Set(local.map((entry) => entry.thread_id))
    return [...local, ...remote.flat().filter((entry) => !seen.has(entry.thread_id))]
  }
  const controlHost = (entry: V2AddressEntry): ControlHost => {
    if (entry.owner === socket) return host
    const peer = peers.get(entry.owner)
    if (peer === undefined) throw Error(`host_unavailable:${entry.owner}`)
    return peer.controlHost()
  }
  const completions = createCompletionTracker(
    (durableId, outcome, throughArmSeq) =>
      store.emitCompletions({
        now: store.now(),
        session_durable_id: durableId,
        outcome,
        through_arm_seq: throughArmSeq,
      }),
    {
      retryAfterMs: () => store.busyTimeoutMs,
      onWriteFailed: (error, retrying) =>
        log(
          `completion report not written${retrying ? ", retrying" : ""}: ${error instanceof Error ? error.message : String(error)}`,
        ),
    },
  )
  const armsPickedUp = new Set<string>()
  const surface: ThreadSurface = {
    host,
    entries,
    controlHost,
    async createSession(input) {
      const caller = await host.session.get({ sessionID: input.callerId })
      const info = await host.session.create({
        location: { directory: input.directory },
        ...(input.title === undefined ? {} : { title: input.title }),
        ...(caller.permissions === undefined ? {} : { permissions: caller.permissions }),
      })
      return addressEntry(info, socket)
    },
  }
  const locate = async (durableId: string) => {
    const info = await host.session.get({ sessionID: durableId }).catch(() => undefined)
    if (info !== undefined) return isClosed(info) ? null : endpointRef(socket, durableId)
    return (await entries()).find((entry) => entry.thread_id === durableId)?.endpoint ?? null
  }
  const defaultEngine = createGatewayEngine({
    store,
    endpoints: drains.endpoints,
    resolve: resolveFromEntries(surface.entries, () => host.location.directory),
    senderProvenance,
  })
  const relay = createGatewayRelay({ store, engine: defaultEngine, endpoints: drains.endpoints, locate })

  const calls: ThreadCallFactory = {
    store,
    relay,
    surface,
    run: tracker.run,
    armCompletion: (durableId, armSeq) => completions.arm(durableId, armSeq),
    transport: (workspaceRoot) =>
      createLocalTransport(
        createGatewayEngine({
          store,
          endpoints: drains.endpoints,
          resolve: resolveFromEntries(surface.entries, workspaceRoot),
          senderProvenance,
        }),
      ),
  }

  async function settled(sessionID: string, outcome: CompletionOutcome): Promise<void> {
    if (!armsPickedUp.has(sessionID) && existsSync(gatewayDatabasePath(agentDir))) {
      armsPickedUp.add(sessionID)
      const latest = await store.latestCompletionArm(sessionID)
      if (latest !== null) completions.arm(sessionID, latest)
    }
    completions.agentEnd(sessionID, endFacts(outcome))
    await completions.settled(sessionID)
  }

  /** A closed thread that runs again is live again: its close marker goes, and the messages queued meanwhile drain. */
  async function reopen(sessionID: string): Promise<void> {
    const info = await host.session.get({ sessionID })
    if (info.metadata?.[THREAD_CLOSED_METADATA_KEY] === undefined) return
    await writeSessionMetadata(host.session, sessionID, THREAD_CLOSED_METADATA_KEY, null)
    await drains.wake(sessionID, [], "start")
  }

  let registration: { readonly dispose: () => Promise<void> } | undefined
  let peerServer: { readonly url: string; readonly close: () => Promise<void> } | undefined
  return {
    tools: createThreadHostTools(calls),
    socket,
    async start() {
      registration = await host.permission.hook("evaluate", (evaluation) => {
        if (
          evaluation.action === "thread_send" &&
          evaluation.metadata?.[THREAD_REPLY_METADATA_KEY] === true &&
          evaluation.effect === "ask"
        )
          evaluation.effect = "allow"
      })
      peerServer = await startPeerServer({
        secret,
        log,
        handlers: {
          host,
          wake: (sessionID, deliveryIds) => drains.wake(sessionID, deliveryIds, "inbox"),
          respondUi: (sessionID, answer) => drains.respondLocal(sessionID, answer),
        },
      })
      registry.publish({
        version: ENDPOINT_REGISTRY_VERSION,
        instance_id: instanceId,
        pid: process.pid,
        socket,
        url: peerServer.url,
        secret,
        directory: host.location.directory,
        created_at: Date.now(),
      })
      tracker.start({
        onSettled: (sessionID, outcome) => {
          void settled(sessionID, outcome).catch((error: unknown) =>
            log(`settle of ${sessionID} failed: ${error instanceof Error ? error.message : String(error)}`),
          )
          drains.release(sessionID)
        },
        onReleased: (sessionID) => drains.release(sessionID),
        onStarted: (sessionID) => {
          void reopen(sessionID).catch((error: unknown) =>
            log(`reopen of ${sessionID} failed: ${error instanceof Error ? error.message : String(error)}`),
          )
        },
      })
    },
    async close() {
      registry.withdraw(instanceId)
      await peerServer?.close()
      peers.clear()
      completions.dispose()
      relay.dispose()
      drains.close()
      await tracker.close()
      await registration?.dispose()
      if (options.store === undefined) await store.dispose().catch(() => undefined)
    },
  }
}
