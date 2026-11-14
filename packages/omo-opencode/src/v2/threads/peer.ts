import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http"
import type { GatewayWakeReply, UiAnswer, UiAnswerReply } from "@oh-my-opencode/thread-core/gateway/adapter"
import type { ControlHost } from "./control"
import type { ThreadV2Host, V2SessionInfo } from "./host"
import { secretMatches, type V2Endpoint } from "./registry"

export const PEER_SECRET_HEADER = "x-omo-thread-secret"
const BODY_MAX_BYTES = 2 * 1024 * 1024
const CALL_TIMEOUT_MS = 15_000
const LIST_PAGE = 200
const LIST_MAX = 2_000

/** The session and catalog calls a peer may run here on another server's behalf, and nothing else. */
const CALLS = [
  "session.get",
  "session.interrupt",
  "session.update",
  "session.switchModel",
  "session.context",
  "model.list",
  "provider.list",
] as const
type CallName = (typeof CALLS)[number]

export type PeerHandlers = {
  readonly host: Pick<ThreadV2Host, "session" | "model" | "provider">
  readonly wake: (sessionID: string, deliveryIds: readonly string[]) => Promise<GatewayWakeReply>
  readonly respondUi: (sessionID: string, answer: UiAnswer) => Promise<UiAnswerReply>
}

class PeerRequestError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message)
  }
}

async function readBody(request: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of request) {
    size += (chunk as Buffer).length
    if (size > BODY_MAX_BYTES) throw new PeerRequestError(413, "request body too large")
    chunks.push(chunk as Buffer)
  }
  const value: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}")
  if (typeof value !== "object" || value === null) throw new PeerRequestError(400, "request body is not an object")
  return value as Record<string, unknown>
}

function sessionIdOf(body: Record<string, unknown>): string {
  const sessionID = body["sessionID"]
  if (typeof sessionID !== "string" || sessionID.length === 0) throw new PeerRequestError(400, "sessionID required")
  return sessionID
}

async function listSessions(session: Pick<ThreadV2Host["session"], "list">): Promise<V2SessionInfo[]> {
  const sessions: V2SessionInfo[] = []
  let cursor: string | undefined
  while (sessions.length < LIST_MAX) {
    const page = await session.list({ limit: LIST_PAGE, order: "desc", ...(cursor === undefined ? {} : { cursor }) })
    sessions.push(...page.data)
    const next = page.cursor.next
    if (next === undefined || next === null || page.data.length === 0) break
    cursor = String(next)
  }
  return sessions
}

/**
 * Runs one whitelisted call for a peer. A session call must name a session this server holds (`session.get` first),
 * and `session.update` may change only a thread's title and metadata, never its permission rules.
 */
async function runCall(handlers: PeerHandlers, name: CallName, input: Record<string, unknown>): Promise<unknown> {
  const { host } = handlers
  if (name === "model.list") return await host.model.list()
  if (name === "provider.list") return await host.provider.list()
  const sessionID = sessionIdOf(input)
  const info = await host.session.get({ sessionID })
  if (name === "session.get") return info
  if (name === "session.interrupt") return await host.session.interrupt({ sessionID, resume: false })
  if (name === "session.context") return await host.session.context({ sessionID })
  if (name === "session.switchModel") {
    const model = input["model"] as { id?: unknown; providerID?: unknown; variant?: unknown } | undefined
    if (typeof model?.id !== "string" || typeof model.providerID !== "string")
      throw new PeerRequestError(400, "model.id and model.providerID required")
    await host.session.switchModel({
      sessionID,
      model: {
        id: model.id,
        providerID: model.providerID,
        ...(typeof model.variant === "string" ? { variant: model.variant } : {}),
      },
    })
    return null
  }
  const title = input["title"]
  const metadata = input["metadata"]
  await host.session.update({
    sessionID,
    ...(typeof title === "string" ? { title } : {}),
    ...(typeof metadata === "object" && metadata !== null
      ? { metadata: metadata as NonNullable<Parameters<ThreadV2Host["session"]["update"]>[0]["metadata"]> }
      : {}),
  })
  return null
}

/** This server's thread RPC endpoint for the other OpenCode 2 servers of the agent dir: loopback only, secret-gated. */
export async function startPeerServer(input: {
  readonly secret: string
  readonly handlers: PeerHandlers
  readonly log: (line: string) => void
}): Promise<{ readonly url: string; readonly close: () => Promise<void> }> {
  const handle = async (request: IncomingMessage, response: ServerResponse) => {
    const reply = (status: number, value: unknown) => {
      response.writeHead(status, { "content-type": "application/json" })
      response.end(JSON.stringify(value))
    }
    try {
      if (request.method !== "POST") throw new PeerRequestError(405, "POST only")
      const header = request.headers[PEER_SECRET_HEADER]
      if (!secretMatches(input.secret, typeof header === "string" ? header : undefined))
        throw new PeerRequestError(401, "bad secret")
      const body = await readBody(request)
      const route = new URL(request.url ?? "/", "http://127.0.0.1").pathname
      if (route === "/v1/list") return reply(200, { sessions: await listSessions(input.handlers.host.session) })
      if (route === "/v1/wake") {
        const sessionID = sessionIdOf(body)
        await input.handlers.host.session.get({ sessionID })
        const ids = Array.isArray(body["delivery_ids"])
          ? body["delivery_ids"].filter((id) => typeof id === "string")
          : []
        return reply(200, await input.handlers.wake(sessionID, ids))
      }
      if (route === "/v1/respond_ui")
        return reply(200, await input.handlers.respondUi(sessionIdOf(body), body["answer"] as UiAnswer))
      if (route === "/v1/call") {
        const name = body["name"]
        if (typeof name !== "string" || !(CALLS as readonly string[]).includes(name))
          throw new PeerRequestError(400, `call ${String(name)} is not allowed`)
        const args = body["input"]
        return reply(200, {
          value: await runCall(
            input.handlers,
            name as CallName,
            typeof args === "object" && args !== null ? (args as Record<string, unknown>) : {},
          ),
        })
      }
      throw new PeerRequestError(404, `no route ${route}`)
    } catch (error) {
      const status = error instanceof PeerRequestError ? error.status : 500
      reply(status, { error: error instanceof Error ? error.message : String(error) })
    }
  }
  const server: Server = createServer((request, response) => {
    void handle(request, response).catch((error: unknown) =>
      input.log(`peer request failed: ${error instanceof Error ? error.message : String(error)}`),
    )
  })
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject)
    server.listen(0, "127.0.0.1", () => resolve())
  })
  server.unref()
  const address = server.address()
  if (address === null || typeof address === "string") throw Error("peer server has no port")
  return {
    url: `http://127.0.0.1:${address.port}`,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections()
        server.close(() => resolve())
      }),
  }
}

export type PeerClient = {
  readonly endpoint: V2Endpoint
  readonly list: () => Promise<V2SessionInfo[]>
  readonly wake: (sessionID: string, deliveryIds: readonly string[]) => Promise<GatewayWakeReply>
  readonly respondUi: (sessionID: string, answer: UiAnswer) => Promise<UiAnswerReply>
  readonly controlHost: () => ControlHost
}

export function createPeerClient(endpoint: V2Endpoint): PeerClient {
  async function post<T>(route: string, body: unknown): Promise<T> {
    let response: Response
    try {
      response = await fetch(endpoint.url + route, {
        method: "POST",
        headers: { "content-type": "application/json", [PEER_SECRET_HEADER]: endpoint.secret },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(CALL_TIMEOUT_MS),
      })
    } catch (error) {
      throw Error(`host_unavailable:${endpoint.socket} (${error instanceof Error ? error.message : String(error)})`)
    }
    const text = await response.text()
    const value = (text ? JSON.parse(text) : {}) as T & { readonly error?: string }
    if (!response.ok) throw Error(`peer ${endpoint.instance_id} refused ${route}: ${value.error ?? response.status}`)
    return value
  }
  const call = async <T>(name: CallName, input: unknown) =>
    (await post<{ readonly value: T }>("/v1/call", { name, input })).value
  type Session = ThreadV2Host["session"]
  return {
    endpoint,
    list: async () => (await post<{ readonly sessions: V2SessionInfo[] }>("/v1/list", {})).sessions,
    wake: (sessionID, deliveryIds) => post("/v1/wake", { sessionID, delivery_ids: deliveryIds }),
    respondUi: (sessionID, answer) => post("/v1/respond_ui", { sessionID, answer }),
    controlHost: () => ({
      session: {
        get: (input) => call<Awaited<ReturnType<Session["get"]>>>("session.get", input),
        interrupt: (input) => call<Awaited<ReturnType<Session["interrupt"]>>>("session.interrupt", input),
        update: async (input) => {
          await call<null>("session.update", input)
        },
        switchModel: async (input) => {
          await call<null>("session.switchModel", input)
        },
        context: (input) => call<Awaited<ReturnType<Session["context"]>>>("session.context", input),
      },
      model: { list: () => call<Awaited<ReturnType<ThreadV2Host["model"]["list"]>>>("model.list", {}) },
      provider: { list: () => call<Awaited<ReturnType<ThreadV2Host["provider"]["list"]>>>("provider.list", {}) },
    }),
  }
}
