import type { GatewayEndpointRef } from "@oh-my-opencode/thread-core/gateway/adapter"
import type { GatewayAddressEntry } from "@oh-my-opencode/thread-core/gateway/engine"
import { threadLink } from "@oh-my-opencode/thread-core/thread-link"
import { isClosed, type ThreadV2Host, type V2SessionInfo } from "./host"

const LIST_PAGE = 200
const LIST_MAX = 2_000

export type V2AddressEntry = GatewayAddressEntry & { readonly info: V2SessionInfo }

export function endpointRef(socket: string, sessionID: string): GatewayEndpointRef {
  return { kind: "rpc_host", socket, routing_id: sessionID, durable_session_id: sessionID }
}

export function sessionTitle(info: V2SessionInfo): string {
  const title = info.title?.trim()
  return title === undefined || title === "" ? info.id : title
}

/** A session the server holds is live and reachable; a closed one is resumable and takes queued messages. */
export function addressEntry(info: V2SessionInfo, socket: string): V2AddressEntry {
  const archived = isClosed(info)
  return {
    info,
    thread_id: info.id,
    name: info.title?.trim() ?? "",
    status: archived ? "resumable" : "live",
    cwd: info.location.directory,
    created_at: new Date(info.time.created).toISOString(),
    updated_at: new Date(info.time.updated).toISOString(),
    endpoint: archived ? null : endpointRef(socket, info.id),
    surface: info.parentID === undefined ? null : "child",
    alive: !archived,
    controls: archived ? ["send", "read"] : ["send", "read", "rename", "set_model", "set_reasoning", "interrupt"],
    liveness: archived ? "dead" : "routable",
  }
}

export async function listAddressEntries(
  session: Pick<ThreadV2Host["session"], "list">,
  socket: string,
): Promise<V2AddressEntry[]> {
  const entries: V2AddressEntry[] = []
  let cursor: string | undefined
  while (entries.length < LIST_MAX) {
    const page = await session.list({ limit: LIST_PAGE, order: "desc", ...(cursor === undefined ? {} : { cursor }) })
    for (const info of page.data) entries.push(addressEntry(info, socket))
    const next = page.cursor.next
    if (next === undefined || next === null || page.data.length === 0) break
    cursor = String(next)
  }
  return entries
}

export function summaryOf(entry: V2AddressEntry) {
  const { info, liveness: _liveness, preview: _preview, transport: _transport, aliases: _aliases, ...summary } = entry
  return { ...summary, link: threadLink(entry.thread_id, sessionTitle(info)) }
}
