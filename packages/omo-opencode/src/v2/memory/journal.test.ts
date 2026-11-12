import { afterEach, describe, expect, test } from "bun:test"
import { existsSync, readdirSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { registerMemoryComponent } from "./index"
import { createMemoryFixture } from "./test-support"

const fixtures: ReturnType<typeof createMemoryFixture>[] = []
function fixture(settings: Record<string, unknown> = {}) {
  const created = createMemoryFixture(settings)
  fixtures.push(created)
  return created
}
afterEach(() => {
  for (const created of fixtures.splice(0)) created.cleanup()
})

const user = (id: string, text: string) => ({ id, type: "user", text, time: { created: 1 } })
const assistant = (id: string, content: unknown[], extra: Record<string, unknown> = {}) => ({
  id,
  type: "assistant",
  agent: "build",
  model: { providerID: "p", modelID: "m" },
  time: { created: 2 },
  content,
  ...extra,
})
const synthetic = (id: string, text: string) => ({ id, type: "synthetic", text, time: { created: 3 } })

function transcriptRows(root: string | undefined, sessionID: string): Record<string, unknown>[] {
  const file = findTranscript(root ?? "", sessionID)
  if (file === undefined) return []
  return readFileSync(file, "utf8")
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as Record<string, unknown>)
}

function findTranscript(dir: string, sessionID: string): string | undefined {
  if (!existsSync(dir)) return undefined
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue
    const path = join(dir, entry.name)
    const candidate = join(path, sessionID, "transcript.jsonl")
    if (entry.name === "transcripts" && existsSync(candidate)) return candidate
    const nested = findTranscript(path, sessionID)
    if (nested !== undefined) return nested
  }
  return undefined
}

async function eventually(check: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 200 && !check(); attempt++) await new Promise((resolve) => setTimeout(resolve, 10))
}

describe("memory transcript journal", () => {
  test("#given a settled root session #when experimental.idle fires #then its user, assistant, reasoning, tool and error rows are appended", async () => {
    // given
    const f = fixture()
    f.addSession("root", {
      messages: [
        user("msg_1", "my coffee order is a flat white"),
        assistant(
          "msg_2",
          [
            { type: "reasoning", text: "the user stated a preference" },
            { type: "text", text: "Noted." },
            {
              type: "tool",
              id: "call_1",
              name: "read",
              state: { status: "completed", input: { path: "a.md" }, content: [{ type: "text", text: "file body" }] },
              time: { created: 2 },
            },
            {
              type: "tool",
              id: "call_2",
              name: "bash",
              state: { status: "error", input: { command: "false" }, error: { type: "exit", message: "exit 1" } },
              time: { created: 2 },
            },
          ],
          { error: { type: "provider", message: "stream cut" } },
        ),
        synthetic("msg_3", "/memory output never re-enters the journal"),
      ],
    })
    const cleanup = await registerMemoryComponent(f.host, f.options())
    // when
    await f.idle("root")
    // then
    const rows = transcriptRows(f.env.OMO_MEMORY_HOME, "root")
    expect(rows.map((row) => row.source_line_id)).toEqual([
      "msg_1:user",
      "msg_2:assistant",
      "msg_2:reasoning:0",
      "msg_2:tool:call_1",
      "msg_2:tool:call_2",
      "msg_2:error",
    ])
    expect(rows.find((row) => row.source_line_id === "msg_2:tool:call_1")).toMatchObject({
      name: "read",
      argsText: '{"path":"a.md"}',
      resultText: "file body",
      resultOk: true,
    })
    expect(rows.find((row) => row.source_line_id === "msg_2:tool:call_2")).toMatchObject({
      resultText: "exit 1",
      resultOk: false,
    })
    await cleanup()
  })

  test("#given an already journaled session #when experimental.idle fires again #then nothing new is appended", async () => {
    // given
    const f = fixture()
    f.addSession("root", { messages: [user("msg_1", "hello"), assistant("msg_2", [{ type: "text", text: "hi" }])] })
    const cleanup = await registerMemoryComponent(f.host, f.options())
    await f.idle("root")
    const first = transcriptRows(f.env.OMO_MEMORY_HOME, "root")
    // when
    await f.idle("root")
    // then
    expect(first).toHaveLength(2)
    expect(transcriptRows(f.env.OMO_MEMORY_HOME, "root")).toEqual(first)
    await cleanup()
  })

  test("#given a child session and a root session refused by the memory root guard #when they settle #then neither is journaled", async () => {
    // given
    const child = fixture()
    child.addSession("child", { parentID: "root", messages: [user("msg_1", "child work")] })
    const childCleanup = await registerMemoryComponent(child.host, child.options())
    const refused = fixture()
    refused.addSession("root", { messages: [user("msg_1", "refused root")] })
    const refusedCleanup = await registerMemoryComponent(
      refused.host,
      refused.options({ env: { OMO_MEMORY_HOME: join(refused.home, ".omo") } }),
    )
    // when
    await child.idle("child")
    await refused.idle("root")
    // then
    expect(existsSync(child.env.OMO_MEMORY_HOME ?? "")).toBe(false)
    expect(existsSync(join(refused.home, ".omo"))).toBe(false)
    await childCleanup()
    await refusedCleanup()
  })

  test("#given turns the host completed before this process saw the session #when the session first binds #then the journal catches up without a settlement", async () => {
    // given
    const f = fixture()
    f.addSession("root", {
      messages: [
        user("msg_1", "from before the reload"),
        assistant("msg_2", [{ type: "text", text: "earlier answer" }]),
      ],
    })
    const cleanup = await registerMemoryComponent(f.host, f.options())
    // when
    await f.context("root")
    await eventually(() => transcriptRows(f.env.OMO_MEMORY_HOME, "root").length === 2)
    // then
    expect(transcriptRows(f.env.OMO_MEMORY_HOME, "root").map((row) => row.text)).toEqual([
      "from before the reload",
      "earlier answer",
    ])
    await cleanup()
  })
})
