import { mkdtempSync, realpathSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { ToolContext } from "@opencode/plugin/promise/tool"
import type { OwnedEvalHostTool } from "../tools/codemode-host-tools"
import type { ThreadV2Host } from "./host"

type Session = {
  id: string
  title?: string
  directory: string
  busy?: number
  idle?: number
  archived?: number
  model?: { id: string; providerID: string; variant?: string }
  metadata?: Record<string, string>
}

type Synthetic = {
  readonly sessionID: string
  readonly id: string
  readonly text: string
  readonly delivery: string
  readonly metadata: Record<string, unknown>
}

type Event = { readonly type: string; readonly data: Record<string, unknown> }

export function createFakeThreadHost() {
  const project = realpathSync(mkdtempSync(join(tmpdir(), "omo-v2-threads-project-")))
  const agentDir = mkdtempSync(join(tmpdir(), "omo-v2-threads-agent-"))
  const sessions = new Map<string, Session>()
  const synthetics: Synthetic[] = []
  const accepted = new Map<string, Synthetic>()
  const interrupts: string[] = []
  const updates: Record<string, unknown>[] = []
  const asserts: Record<string, unknown>[] = []
  const pendingPermissions = new Map<string, { id: string }[]>()
  const evaluateHooks: ((input: { action: string; metadata?: Record<string, unknown>; effect: string }) => void)[] = []
  const queue: Event[] = []
  let wakeReader: (() => void) | undefined
  let created = 0

  const info = (session: Session) => ({
    id: session.id,
    projectID: "project",
    cost: 0,
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    time: {
      created: 1_700_000_000_000,
      updated: 1_700_000_000_000,
      ...(session.busy === undefined ? {} : { busy: session.busy }),
      ...(session.idle === undefined ? {} : { idle: session.idle }),
      ...(session.archived === undefined ? {} : { archived: session.archived }),
    },
    ...(session.title === undefined ? {} : { title: session.title }),
    ...(session.model === undefined ? {} : { model: session.model }),
    ...(session.metadata === undefined ? {} : { metadata: session.metadata }),
    location: { directory: session.directory },
  })
  const find = (sessionID: string) => {
    const session = sessions.get(sessionID)
    if (session === undefined) throw Error(`session ${sessionID} not found`)
    return session
  }

  const host = {
    location: { directory: project },
    session: {
      get: async ({ sessionID }: { sessionID: string }) => info(find(sessionID)),
      list: async () => ({ data: [...sessions.values()].map(info), cursor: {} }),
      create: async (input: { title?: string; location?: { directory: string } }) => {
        const id = `ses_created_${++created}`
        sessions.set(id, {
          id,
          directory: input.location?.directory ?? project,
          ...(input.title ? { title: input.title } : {}),
        })
        return info(find(id))
      },
      synthetic: async (input: Synthetic & { resume?: boolean; description?: string }) => {
        const prior = accepted.get(input.id)
        if (prior === undefined) {
          const record = {
            sessionID: input.sessionID,
            id: input.id,
            text: input.text,
            delivery: input.delivery,
            metadata: input.metadata,
          }
          accepted.set(input.id, record)
          synthetics.push(record)
        }
        const row = accepted.get(input.id) as Synthetic
        return {
          id: row.id,
          sessionID: row.sessionID,
          time: { created: 1 },
          type: "synthetic" as const,
          payload: { text: row.text },
          delivery: row.delivery,
        }
      },
      interrupt: async ({ sessionID }: { sessionID: string }) => {
        interrupts.push(sessionID)
        const session = find(sessionID)
        session.idle = (session.busy ?? 0) + 1
        return { interrupted: true }
      },
      update: async (input: { sessionID: string; title?: string; metadata?: Record<string, string> }) => {
        updates.push(input)
        const session = find(input.sessionID)
        if (input.title !== undefined) session.title = input.title
        if (input.metadata !== undefined) session.metadata = input.metadata
      },
      switchModel: async (input: { sessionID: string; model: Session["model"] }) => {
        find(input.sessionID).model = input.model
      },
      context: async () => [
        { id: "m1", type: "user", text: "hello", time: { created: 1_700_000_000_000 } },
        { id: "m2", type: "assistant", content: [{ type: "text", text: "hi" }], time: { created: 1_700_000_000_001 } },
      ],
    },
    permission: {
      list: async ({ sessionID }: { sessionID: string }) => pendingPermissions.get(sessionID) ?? [],
      reply: async () => undefined,
      assert: async (input: Record<string, unknown>) => {
        asserts.push(input)
      },
      hook: async (_name: string, callback: (input: never) => void) => {
        evaluateHooks.push(callback as never)
        return { dispose: async () => undefined }
      },
    },
    event: {
      subscribe: ({ signal }: { signal?: AbortSignal }) => ({
        async *[Symbol.asyncIterator]() {
          while (!signal?.aborted) {
            const next = queue.shift()
            if (next !== undefined) {
              yield next
              continue
            }
            await new Promise<void>((resolve) => {
              wakeReader = resolve
              signal?.addEventListener("abort", () => resolve(), { once: true })
            })
          }
        },
      }),
    },
    model: {
      list: async () => ({
        data: [
          {
            providerID: "mock",
            id: "m",
            modelID: "m",
            name: "Mock",
            status: "active",
            variants: [{ id: "high" }],
            capabilities: { tools: true, input: ["text"], output: ["text"] },
            limit: { context: 1, output: 1 },
          },
        ],
      }),
    },
    provider: { list: async () => ({ data: [{ id: "mock" }] }) },
  }

  return {
    host: host as unknown as ThreadV2Host,
    project,
    agentDir,
    sessions,
    synthetics,
    interrupts,
    updates,
    asserts,
    pendingPermissions,
    evaluateHooks,
    addSession(session: Omit<Session, "directory"> & { directory?: string }) {
      sessions.set(session.id, { directory: project, ...session })
    },
    emit(event: Event) {
      queue.push(event)
      wakeReader?.()
    },
    cleanup() {
      rmSync(project, { recursive: true, force: true })
      rmSync(agentDir, { recursive: true, force: true })
    },
  }
}

function callerOf(sessionID: string): ToolContext {
  return {
    sessionID,
    agent: "build",
    messageID: "msg_caller",
    id: "call_eval",
    signal: new AbortController().signal,
    progress: async () => undefined,
  } as unknown as ToolContext
}

export async function callTool(tools: readonly OwnedEvalHostTool[], name: string, sessionID: string, params: unknown) {
  const tool = tools.find((candidate) => candidate.name === name)
  if (tool === undefined) throw Error(`no tool ${name}`)
  const result = await tool.execute(params, { sessionID, caller: callerOf(sessionID) })
  return (result.details as { result: Record<string, unknown> }).result
}
