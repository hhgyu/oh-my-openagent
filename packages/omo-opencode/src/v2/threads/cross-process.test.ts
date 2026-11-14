import { afterEach, describe, expect, test } from "bun:test"
import { spawnSync } from "node:child_process"
import { existsSync, readdirSync } from "node:fs"
import { join } from "node:path"
import { createThreadComponent, type ThreadComponent } from "./component"
import { ENDPOINT_REGISTRY_VERSION, createEndpointRegistry, endpointRegistryDirectory } from "./registry"
import { callTool, createFakeThreadHost } from "./test-support"

const started: ThreadComponent[] = []
const fakes: ReturnType<typeof createFakeThreadHost>[] = []

async function twoServers() {
  const first = createFakeThreadHost()
  const second = createFakeThreadHost()
  fakes.push(first, second)
  first.addSession({ id: "ses_a", title: "alpha", busy: 10, idle: 20 })
  second.addSession({ id: "ses_b", title: "beta", busy: 10, idle: 20, directory: first.project })
  const a = createThreadComponent(first.host, { agentDir: first.agentDir, env: {} })
  const b = createThreadComponent(second.host, { agentDir: first.agentDir, env: {} })
  await a.start()
  await b.start()
  started.push(a, b)
  return { first, second, a, b }
}

function deadPid(): number {
  const child = spawnSync(process.execPath, ["-e", "process.exit(0)"], { windowsHide: true })
  return child.pid ?? 0
}

afterEach(async () => {
  for (const component of started.splice(0)) await component.close()
  for (const fake of fakes.splice(0)) fake.cleanup()
})

describe("V2 thread tools across OpenCode servers of one agent dir", () => {
  describe("#given two servers that published themselves in the registry", () => {
    test("#when A lists threads #then B's session is listed through the peer endpoint", async () => {
      // given
      const { first, a } = await twoServers()

      // when
      const listed = await callTool(a.tools, "thread_list", "ses_a", {})

      // then
      expect(
        readdirSync(endpointRegistryDirectory(first.agentDir)).filter((name) => name.endsWith(".json")),
      ).toHaveLength(2)
      expect((listed["threads"] as { thread_id: string }[]).map((thread) => thread.thread_id).sort()).toEqual([
        "ses_a",
        "ses_b",
      ])
    })

    test("#when A sends to B twice under one key #then B's server posts exactly one synthetic and B's reply reaches A", async () => {
      // given
      const { first, second, a, b } = await twoServers()

      // when
      const sent = await callTool(a.tools, "thread_send", "ses_a", {
        thread: "beta",
        message: "cross ping",
        idempotency_key: "x1",
      })
      const again = await callTool(a.tools, "thread_send", "ses_a", {
        thread: "beta",
        message: "cross ping",
        idempotency_key: "x1",
      })
      const metadata = second.synthetics[0]?.metadata ?? {}
      second.emit({
        type: "session.inbox.enqueued",
        data: { sessionID: "ses_b", inboxID: "msg_in", item: { type: "synthetic", payload: { text: "", metadata } } },
      })
      second.emit({ type: "session.inbox.delivered", data: { sessionID: "ses_b", inboxID: "msg_in" } })
      await new Promise((resolve) => setTimeout(resolve, 100))
      const reply = await callTool(b.tools, "thread_send", "ses_b", { thread: "ses_a", message: "cross pong" })

      // then
      expect(sent).toMatchObject({ kind: "ok", thread_id: "ses_b", delivery: { kind: "started" } })
      expect(again).toMatchObject({ kind: "ok", deduplicated: true, delivery_id: sent["delivery_id"] })
      expect(second.synthetics.map((entry) => entry.sessionID)).toEqual(["ses_b"])
      expect(reply).toMatchObject({ kind: "ok", thread_id: "ses_a", delivery: { kind: "started" } })
      expect(first.synthetics.map((entry) => entry.sessionID)).toEqual(["ses_a"])
      expect(second.asserts[0]).toMatchObject({ metadata: { omoThreadReplyAllowed: true } })
    })

    test("#when A reads and interrupts B's session #then the calls run on B's server", async () => {
      // given
      const { second, a } = await twoServers()
      const b = second.sessions.get("ses_b")
      if (b) b.busy = 30

      // when
      const read = await callTool(a.tools, "thread_read", "ses_a", { thread: "beta" })
      const interrupted = await callTool(a.tools, "thread_interrupt", "ses_a", { thread: "beta" })

      // then
      expect(read).toMatchObject({ kind: "ok", thread_id: "ses_b", source: "live_host" })
      expect(interrupted).toMatchObject({ kind: "ok", interrupted: true, turn_id: "30" })
      expect(second.interrupts).toEqual(["ses_b"])
    })
  })

  describe("#given a registry entry left by a server that died", () => {
    test("#when a server reads the registry #then the dead entry is ignored and its file removed", async () => {
      // given
      const { first, a } = await twoServers()
      const registry = createEndpointRegistry(first.agentDir)
      registry.publish({
        version: ENDPOINT_REGISTRY_VERSION,
        instance_id: "dead0000-0000-4000-8000-000000000000",
        pid: deadPid(),
        socket: "opencode-v2:dead",
        url: "http://127.0.0.1:9",
        secret: "x".repeat(64),
        directory: first.project,
        created_at: 1,
      })
      const deadFile = join(registry.directory, "dead0000-0000-4000-8000-000000000000.json")

      // when
      const listed = await callTool(a.tools, "thread_list", "ses_a", {})

      // then
      expect((listed["threads"] as unknown[]).length).toBe(2)
      expect(existsSync(deadFile)).toBe(false)
    })

    test("#when a server closes #then it withdraws its own entry", async () => {
      // given
      const { first, b } = await twoServers()

      // when
      await b.close()

      // then
      expect(
        readdirSync(endpointRegistryDirectory(first.agentDir)).filter((name) => name.endsWith(".json")),
      ).toHaveLength(1)
    })
  })
})
