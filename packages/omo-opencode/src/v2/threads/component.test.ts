import { afterEach, describe, expect, test } from "bun:test"
import { createThreadComponent, type ThreadComponent } from "./component"
import { threadDeliveryInputId } from "./delivery-metadata"
import { callTool, createFakeThreadHost } from "./test-support"

const live: { component: ThreadComponent; fake: ReturnType<typeof createFakeThreadHost> }[] = []

async function setup() {
  const fake = createFakeThreadHost()
  fake.addSession({ id: "ses_a", title: "alpha", busy: 10, idle: 20 })
  fake.addSession({ id: "ses_b", title: "beta", busy: 10, idle: 20 })
  const component = createThreadComponent(fake.host, { agentDir: fake.agentDir, env: {} })
  await component.start()
  live.push({ component, fake })
  return { fake, component }
}

afterEach(async () => {
  for (const entry of live.splice(0)) {
    await entry.component.close()
    entry.fake.cleanup()
  }
})

describe("V2 thread tools", () => {
  describe("#given the component", () => {
    test("#then it exposes the eighteen Native thread tools as owned eval host tools only", async () => {
      // given
      const { component } = await setup()

      // when
      const names = component.tools.map((tool) => tool.name).sort()

      // then
      expect(names).toEqual(
        [
          "thread_answer",
          "thread_bind",
          "thread_bindings",
          "thread_close",
          "thread_create",
          "thread_handoff",
          "thread_interrupt",
          "thread_list",
          "thread_outbox",
          "thread_outbox_ack",
          "thread_read",
          "thread_rebind",
          "thread_rename",
          "thread_report",
          "thread_send",
          "thread_set_model",
          "thread_set_reasoning",
          "thread_unbind",
        ].sort(),
      )
    })
  })

  describe("#given two live sessions on the same server", () => {
    test("#when A sends to idle B twice under one key #then B receives exactly one synthetic and a turn starts", async () => {
      // given
      const { fake, component } = await setup()

      // when
      const first = await callTool(component.tools, "thread_send", "ses_a", {
        thread: "beta",
        message: "please review",
        idempotency_key: "k1",
      })
      const again = await callTool(component.tools, "thread_send", "ses_a", {
        thread: "beta",
        message: "please review",
        idempotency_key: "k1",
      })

      // then
      expect(first).toMatchObject({
        kind: "ok",
        thread_id: "ses_b",
        delivery: { kind: "started" },
        deduplicated: false,
      })
      expect(again).toMatchObject({ kind: "ok", deduplicated: true, delivery_id: first["delivery_id"] })
      expect(fake.synthetics).toHaveLength(1)
      expect(fake.synthetics[0]).toMatchObject({
        sessionID: "ses_b",
        id: threadDeliveryInputId(String(first["delivery_id"])),
        delivery: "queue",
      })
      expect(fake.synthetics[0]?.text).toContain('"please review"')
      expect(fake.asserts[0]).toMatchObject({ action: "thread_send", resources: ["ses_b"] })
    })

    test("#when B consumed A's delivery and replies #then the reply reaches A under the reply allowance", async () => {
      // given
      const { fake, component } = await setup()
      const sent = await callTool(component.tools, "thread_send", "ses_a", { thread: "ses_b", message: "ping" })
      const metadata = fake.synthetics[0]?.metadata ?? {}
      fake.emit({
        type: "session.inbox.enqueued",
        data: { sessionID: "ses_b", inboxID: "msg_in", item: { type: "synthetic", payload: { text: "", metadata } } },
      })
      fake.emit({ type: "session.inbox.delivered", data: { sessionID: "ses_b", inboxID: "msg_in" } })
      await new Promise((resolve) => setTimeout(resolve, 50))

      // when
      const reply = await callTool(component.tools, "thread_send", "ses_b", { thread: "ses_a", message: "pong" })

      // then
      expect(sent).toMatchObject({ kind: "ok" })
      expect(reply).toMatchObject({ kind: "ok", thread_id: "ses_a" })
      expect(fake.synthetics.map((entry) => entry.sessionID)).toEqual(["ses_b", "ses_a"])
      expect(fake.asserts[1]).toMatchObject({ metadata: { omoThreadReplyAllowed: true } })
      const evaluation = { action: "thread_send", metadata: { omoThreadReplyAllowed: true }, effect: "ask" }
      for (const hook of fake.evaluateHooks) hook(evaluation)
      expect(evaluation.effect).toBe("allow")
    })

    test("#when B is parked on an approval #then the send queues and reports waiting_on approval", async () => {
      // given
      const { fake, component } = await setup()
      const b = fake.sessions.get("ses_b")
      if (b) b.busy = 30
      fake.pendingPermissions.set("ses_b", [{ id: "per_1" }])

      // when
      const sent = await callTool(component.tools, "thread_send", "ses_a", { thread: "ses_b", message: "status?" })

      // then
      expect(sent).toMatchObject({ kind: "ok", delivery: { kind: "queued", waiting_on: { kind: "approval" } } })
      expect(fake.synthetics[0]).toMatchObject({ sessionID: "ses_b", delivery: "queue" })
    })

    test("#when B runs a turn #then an auto send steers it", async () => {
      // given
      const { fake, component } = await setup()
      const b = fake.sessions.get("ses_b")
      if (b) b.busy = 30

      // when
      const sent = await callTool(component.tools, "thread_send", "ses_a", { thread: "ses_b", message: "also this" })

      // then
      expect(sent).toMatchObject({ kind: "ok", delivery: { kind: "steered", turn_id: "30" } })
      expect(fake.synthetics[0]).toMatchObject({ delivery: "steer" })
    })

    test("#when A steers B with a stale turn id #then the gateway refuses turn_conflict and posts nothing", async () => {
      // given
      const { fake, component } = await setup()
      const b = fake.sessions.get("ses_b")
      if (b) b.busy = 30

      // when
      const sent = await callTool(component.tools, "thread_send", "ses_a", {
        thread: "ses_b",
        message: "steer",
        delivery: "steer",
        expected_turn_id: "29",
      })

      // then
      expect(sent).toMatchObject({ kind: "error", error: { code: "turn_conflict" } })
      expect(fake.synthetics).toHaveLength(0)
    })

    test("#when A creates a thread #then a session opens in the caller's workspace and the alias stays local", async () => {
      // given
      const { fake, component } = await setup()

      // when
      const created = await callTool(component.tools, "thread_create", "ses_a", { alias: "worker" })
      const forked = await callTool(component.tools, "thread_create", "ses_a", { fork_from: "ses_b" })

      // then
      expect(created).toMatchObject({
        kind: "ok",
        thread: { name: "worker", cwd: fake.project },
        alias_scope: "local",
        alias_unavailable: "no_remote",
      })
      expect(forked).toMatchObject({ kind: "error", error: { code: "unsupported" } })
    })

    test("#when A interrupts and closes B #then the session API interrupts it, it lists as resumable and a queued message drains when it runs again", async () => {
      // given
      const { fake, component } = await setup()
      const b = fake.sessions.get("ses_b")
      if (b) b.busy = 30

      // when
      const interrupted = await callTool(component.tools, "thread_interrupt", "ses_a", { thread: "ses_b" })
      const closed = await callTool(component.tools, "thread_close", "ses_a", { thread: "ses_b" })
      const again = await callTool(component.tools, "thread_close", "ses_a", { thread: "ses_b" })

      // then
      expect(interrupted).toMatchObject({ kind: "ok", thread_id: "ses_b", interrupted: true, turn_id: "30" })
      expect(closed).toMatchObject({ kind: "ok", thread_id: "ses_b", closed: true })
      expect(again).toMatchObject({ kind: "ok", closed: false })
      expect(fake.interrupts).toEqual(["ses_b"])
      expect(fake.sessions.get("ses_b")?.metadata?.["omoThreadClosed"]).toBeString()
      const listed = await callTool(component.tools, "thread_list", "ses_a", {})
      expect(listed["threads"]).toContainEqual(expect.objectContaining({ thread_id: "ses_b", status: "resumable" }))
      const queued = await callTool(component.tools, "thread_send", "ses_a", { thread: "ses_b", message: "later" })
      expect(queued).toMatchObject({ kind: "ok", delivery: { kind: "queued_offline" } })
      expect(fake.synthetics).toHaveLength(0)
      fake.emit({ type: "session.execution.started", data: { sessionID: "ses_b" } })
      await new Promise((resolve) => setTimeout(resolve, 300))
      expect(fake.sessions.get("ses_b")?.metadata?.["omoThreadClosed"]).toBeUndefined()
      expect(fake.synthetics.map((entry) => entry.sessionID)).toEqual(["ses_b"])
    })

    test("#when A lists, renames, reads and sets reasoning #then each answers through the session API", async () => {
      // given
      const { fake, component } = await setup()
      const b = fake.sessions.get("ses_b")
      if (b) b.model = { providerID: "mock", id: "m" }

      // when
      const listed = await callTool(component.tools, "thread_list", "ses_a", {})
      const renamed = await callTool(component.tools, "thread_rename", "ses_a", { thread: "ses_b", name: "gamma" })
      const conflict = await callTool(component.tools, "thread_rename", "ses_a", { thread: "ses_b", name: "alpha" })
      const read = await callTool(component.tools, "thread_read", "ses_a", { thread: "gamma" })
      const high = await callTool(component.tools, "thread_set_reasoning", "ses_a", { thread: "ses_b", level: "high" })
      const max = await callTool(component.tools, "thread_set_reasoning", "ses_a", { thread: "ses_b", level: "max" })

      // then
      expect((listed["threads"] as { thread_id: string }[]).map((thread) => thread.thread_id).sort()).toEqual([
        "ses_a",
        "ses_b",
      ])
      expect(renamed).toMatchObject({ kind: "ok", name: "gamma" })
      expect(conflict).toMatchObject({ kind: "error", error: { code: "name_conflict" } })
      expect(read).toMatchObject({ kind: "ok", thread_id: "ses_b", source: "live_host" })
      expect((read["items"] as { role: string }[]).map((item) => item.role)).toEqual(["user", "assistant"])
      expect(high).toMatchObject({ kind: "ok", level: "high" })
      expect(fake.sessions.get("ses_b")?.model).toEqual({ providerID: "mock", id: "m", variant: "high" })
      expect(max).toMatchObject({
        kind: "error",
        error: { code: "thinking_level_unsupported", details: { supported: ["high"] } },
      })
    })

    test("#when A binds itself, reports and reads the outbox #then the relay rows round-trip", async () => {
      // given
      const { component } = await setup()

      // when
      const bound = await callTool(component.tools, "thread_bind", "ses_a", {
        platform: "slack",
        account_id: "acct",
        chat_id: "chat",
      })
      const binding = bound["binding"] as { binding_id: string; revision: number }
      const reported = await callTool(component.tools, "thread_report", "ses_a", {
        binding_id: binding.binding_id,
        kind: "milestone",
        text: "half done",
      })
      const outbox = await callTool(component.tools, "thread_outbox", "ses_a", { binding_id: binding.binding_id })
      const acked = await callTool(component.tools, "thread_outbox_ack", "ses_a", {
        binding_id: binding.binding_id,
        cursor: reported["cursor"],
      })
      const unbound = await callTool(component.tools, "thread_unbind", "ses_a", {
        binding_id: binding.binding_id,
        expected_revision: binding.revision,
      })

      // then
      expect(bound).toMatchObject({ kind: "ok", binding: { session_durable_id: "ses_a", status: "active" } })
      expect(reported).toMatchObject({ kind: "ok", event: "milestone" })
      expect((outbox["rows"] as { text: string }[]).map((row) => row.text)).toEqual(["half done"])
      expect(acked).toMatchObject({ kind: "ok", changed: true })
      expect(unbound).toMatchObject({ kind: "ok", binding: { status: "detached" } })
    })
  })
})
