// Controlled UNIT doubles for the facts extractor: a scripted child port per launch (each turn settles
// only when the test says so) and a one-model catalog. Never spawns OpenCode.
import { readdirSync, readFileSync, statSync } from "node:fs"
import { join } from "node:path"
import type { CatalogModel } from "../host/model-catalog"
import type { FactsPortRequest } from "./facts-child"
import type { MemoryChild, MemoryChildPort, MemoryChildStartInput, MemoryChildTurnReport } from "./memory-child-port"

export interface ScriptedFactsChild extends MemoryChild {
  readonly request: FactsPortRequest
  readonly start: MemoryChildStartInput
  aborts: number
  disposed: boolean
  finish(report?: Partial<MemoryChildTurnReport>): void
}

export interface ScriptedFactsPorts {
  readonly requests: FactsPortRequest[]
  readonly children: ScriptedFactsChild[]
  createPort(request: FactsPortRequest): MemoryChildPort
  started(count: number): Promise<ScriptedFactsChild>
}

export function createScriptedFactsPorts(): ScriptedFactsPorts {
  const requests: FactsPortRequest[] = []
  const children: ScriptedFactsChild[] = []
  const waiters: { count: number; resolve(child: ScriptedFactsChild): void }[] = []
  return {
    requests,
    children,
    createPort(request) {
      requests.push(request)
      const live: ScriptedFactsChild[] = []
      return {
        async start(input) {
          const sessionID = `ses_facts_${children.length + 1}`
          const lease = request.scopes.open(sessionID as Parameters<FactsPortRequest["scopes"]["open"]>[0], { tools: [...request.toolNames], authorize: () => undefined })
          let settle: (report: MemoryChildTurnReport) => void = () => undefined
          const turn = new Promise<MemoryChildTurnReport>(resolve => { settle = resolve })
          const child: ScriptedFactsChild = {
            sessionID, generation: input.generation, request, start: input, aborts: 0, disposed: false,
            async followUp() {},
            async steer() {},
            async abort() { child.aborts += 1; settle({ status: "cancelled", userTexts: [] }) },
            waitForIdle: () => turn,
            async dispose() {
              if (child.disposed) return
              child.disposed = true
              settle({ status: "cancelled", userTexts: [] })
              if (!lease.signal.aborted) request.scopes.retire(lease)
              request.onRetired(sessionID)
            },
            finish(report = {}) { settle({ status: "completed", userTexts: [input.prompt], ...report }) },
          }
          request.onIssued({ sessionID, lease })
          children.push(child)
          live.push(child)
          for (const waiter of waiters.filter(entry => entry.count === children.length)) waiter.resolve(child)
          return child
        },
        async close() { await Promise.all(live.map(child => child.dispose())) },
      }
    },
    started(count) {
      const existing = children[count - 1]
      if (existing !== undefined) return Promise.resolve(existing)
      return new Promise(resolve => { waiters.push({ count, resolve }) })
    },
  }
}

export function catalogModel(providerID: string, id: string): CatalogModel {
  return {
    providerID, id, modelID: id, name: id, type: "chat", status: "active",
    reasoning: { source: "opencode.model.variants", variants: [] },
    capabilities: { tools: true, input: ["text"], output: ["text"] },
    limit: { context: 200_000, output: 8_000 },
    availability: { source: "opencode.model.list+provider.list", listed: true, enabled: true, providerListed: true, authentication: "unknown" },
  }
}

/** Polls until the predicate holds; fails the test after `ms`. */
export async function until(predicate: () => boolean | Promise<boolean>, ms = 5_000): Promise<void> {
  const started = Date.now()
  while (!await predicate()) {
    if (Date.now() - started > ms) throw new Error("condition not reached in time")
    await new Promise(resolve => setTimeout(resolve, 10))
  }
}

/** Every file under `dir` whose content includes `text`. */
export function filesContaining(dir: string, text: string): string[] {
  const found: string[] = []
  const walk = (current: string): void => {
    for (const name of readdirSync(current)) {
      if (name === ".git") continue
      const path = join(current, name)
      if (statSync(path).isDirectory()) walk(path)
      else if (readFileSync(path, "utf8").includes(text)) found.push(path)
    }
  }
  walk(dir)
  return found
}

export function conversation(user: string, assistant: string, suffix = "1"): unknown[] {
  return [
    { type: "user", id: `msg_u${suffix}`, text: user },
    { type: "assistant", id: `msg_a${suffix}`, content: [{ type: "text", text: assistant }], model: { providerID: "test", id: "model" } },
  ]
}
