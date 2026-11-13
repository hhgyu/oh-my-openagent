import { afterEach, describe, expect, test } from "bun:test"
import { Error as ToolError } from "@opencode/plugin/promise/tool"
import { registerMemoryComponent, MEMORY_PART_MARKER, RECALL_PART_MARKER } from "./index"
import type { KibitzerWakeOutcome } from "./kibitzer"
import { createCountingSlot, createManualTimers, createScriptedPort, type ScriptedPort } from "./kibitzer/test-support"
import { createMemoryFixture, partsWith, type MemoryFixture } from "./test-support"

const fixtures: MemoryFixture[] = []
afterEach(() => {
  for (const created of fixtures.splice(0)) created.cleanup()
})

const HINT = "The note records that the usual coffee is an oat milk flat white."

async function seeded(settings: Record<string, unknown> = {}) {
  const f = createMemoryFixture(settings)
  fixtures.push(f)
  f.addSession("root")
  f.addSession("child", { parentID: "root" })
  const ports: ScriptedPort[] = []
  const slot = createCountingSlot()
  const outcomes: KibitzerWakeOutcome[] = []
  const waiters: ((outcome: KibitzerWakeOutcome) => void)[] = []
  const cleanup = await registerMemoryComponent(
    f.host,
    f.options({
      kibitzer: {
        createPort: (request) => {
          const port = createScriptedPort(request)
          ports.push(port)
          return port
        },
        createWakeSlot: () => slot,
        timers: createManualTimers(),
        onWake: (outcome) => {
          outcomes.push(outcome)
          waiters.shift()?.(outcome)
        },
      },
    }),
  )
  await f.runTool("memory", "root", {
    command: "create",
    reason: "coffee",
    file_path: "reference/coffee.md",
    description: "Coffee order preference: oat milk flat white",
    file_text: "The usual coffee is an oat milk flat white.",
  })
  await f.runTool("memory", "root", {
    command: "create",
    reason: "deploy",
    file_path: "reference/kubernetes-rollout.md",
    description: "Kubernetes rollout goes through the staging cluster first",
    file_text: "Staging cluster before production rollout.",
  })
  const nextWake = () =>
    new Promise<KibitzerWakeOutcome>((resolve) => {
      waiters.push(resolve)
    })
  const child = async () => {
    for (let attempt = 0; attempt < 200 && ports[0] === undefined; attempt += 1)
      await new Promise((resolve) => setTimeout(resolve, 10))
    const port = ports[0]
    if (port === undefined) throw new Error("no kibitzer port was created")
    return port.started(1)
  }
  return { f, cleanup, ports, slot, outcomes, nextWake, child }
}

const recalledPaths = (system: Awaited<ReturnType<MemoryFixture["context"]>>) =>
  partsWith(system, RECALL_PART_MARKER).flatMap((part) => {
    const paths = part.metadata?.paths
    return Array.isArray(paths) ? paths : []
  })

describe("memory recall through the resident Kibitzer judge", () => {
  test("#given a matching note #when the judge accepts a nudge #then the parent receives it once through the context hook and the ledger stops a repeat", async () => {
    // given
    const s = await seeded()
    await s.f.prompt("root", "which coffee do I usually order")
    const child = await s.child()
    // when
    await s.f.runTool("nudge", child.sessionID, { path: "reference/coffee.md", hint: HINT })
    const wake = s.nextWake()
    child.finish()
    const outcome = await wake
    const first = await s.f.context("root")
    const second = await s.f.context("root")
    await s.f.prompt("root", "which coffee do I usually order")
    // then
    expect(child.prompts[0]).toContain("reference/coffee.md")
    expect(outcome).toMatchObject({ status: "completed", nudges: [{ path: "reference/coffee.md", hint: HINT }] })
    expect(partsWith(first, RECALL_PART_MARKER)).toHaveLength(1)
    expect(partsWith(first, RECALL_PART_MARKER)[0]?.text).toContain(HINT)
    expect(recalledPaths(first)).toEqual(["reference/coffee.md"])
    expect(partsWith(second, RECALL_PART_MARKER)).toHaveLength(0)
    expect(child.followUps).toEqual([])
    expect(s.ports).toHaveLength(1)
    await s.cleanup()
  })

  test("#given tool arguments naming a topic #then the matching note is offered to the judge and nothing is delivered without a nudge", async () => {
    // given
    const s = await seeded()
    // when
    await s.f.toolBefore("root", "read", { filePath: "deploy/kubernetes/rollout.yaml" })
    const child = await s.child()
    const wake = s.nextWake()
    child.finish()
    await wake
    const system = await s.f.context("root")
    // then
    expect(child.prompts[0]).toContain("reference/kubernetes-rollout.md")
    expect(recalledPaths(system)).toEqual([])
    await s.cleanup()
  })

  test("#given recall disabled or a subagent child session #then no judge is started and no recall part is delivered", async () => {
    // given
    const disabled = await seeded({ recall: { enabled: false } })
    const enabled = await seeded()
    // when
    await disabled.f.prompt("root", "which coffee do I usually order")
    const disabledSystem = await disabled.f.context("root")
    await enabled.f.prompt("child", "which coffee do I usually order")
    const childSystem = await enabled.f.context("child")
    // then
    expect(partsWith(disabledSystem, RECALL_PART_MARKER)).toHaveLength(0)
    expect(partsWith(disabledSystem, MEMORY_PART_MARKER)).toHaveLength(1)
    expect(disabled.ports).toEqual([])
    expect(childSystem).toEqual([])
    expect(enabled.ports).toEqual([])
    await disabled.cleanup()
    await enabled.cleanup()
  })

  test("#given a live judge child #then its requests see only the five contract tools while the parent cannot call them", async () => {
    // given
    const s = await seeded()
    await s.f.prompt("root", "which coffee do I usually order")
    const child = await s.child()
    const tools = Object.fromEntries(
      ["read", "grep", "session_entries", "memory", "nudge", "edit", "shell", "memory_apply_patch"].map((name) => [
        name,
        { description: name, input: {} },
      ]),
    )
    // when
    const childSystem = await s.f.context(child.sessionID, [], { tools })
    const parentNudge = s.f.runTool("nudge", "root", { path: "reference/coffee.md", hint: HINT })
    const parentEntries = s.f.runTool("session_entries", "root", {})
    const page = await s.f.runTool("session_entries", child.sessionID, { since: -1 }, "c2")
    // then
    expect(Object.keys(tools).sort()).toEqual(["grep", "memory", "nudge", "read", "session_entries"])
    expect(tools.memory?.description).toContain("Read-only")
    expect(childSystem).toEqual([])
    await expect(parentNudge).rejects.toBeInstanceOf(ToolError)
    await expect(parentEntries).rejects.toBeInstanceOf(ToolError)
    expect(JSON.parse(String(page.content)).entries).toEqual([expect.objectContaining({ cursor: 1, type: "prompt" })])
    await s.cleanup()
  })

  test("#given a live judge child #when the parent's requests and compactions run #then the parent never sees session_entries or nudge while the child compaction keeps the contract tools", async () => {
    // given
    const s = await seeded()
    await s.f.prompt("root", "which coffee do I usually order")
    const child = await s.child()
    const offered = () =>
      Object.fromEntries(
        ["read", "grep", "session_entries", "memory", "nudge", "edit"].map((name) => [
          name,
          { description: name, input: {} },
        ]),
      )
    const parentContext = offered()
    const parentCompaction = offered()
    const childCompaction = offered()
    // when
    await s.f.context("root", [], { tools: parentContext })
    await s.f.compaction("root", [], parentCompaction)
    await s.f.compaction(child.sessionID, [], childCompaction)
    // then
    expect(Object.keys(parentContext).sort()).toEqual(["edit", "grep", "memory", "read"])
    expect(Object.keys(parentCompaction).sort()).toEqual(["edit", "grep", "memory", "read"])
    expect(Object.keys(childCompaction).sort()).toEqual(["grep", "memory", "nudge", "read", "session_entries"])
    expect(childCompaction.memory?.description).toContain("Read-only")
    await s.cleanup()
  })

  test("#given a running judge child #when the component unloads #then the wake is cancelled, the child is closed and the lease is released", async () => {
    // given
    const s = await seeded()
    await s.f.prompt("root", "which coffee do I usually order")
    const child = await s.child()
    const wake = s.nextWake()
    // when
    await s.cleanup()
    const outcome = await wake
    // then
    expect(outcome).toMatchObject({ status: "cancelled", cause: "shutdown" })
    expect(child.disposed).toBe(true)
    expect(s.ports[0]?.closed).toBe(true)
    expect(s.slot.live).toBe(0)
    expect(s.f.tools.size).toBe(0)
  })
})
