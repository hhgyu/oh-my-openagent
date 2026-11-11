import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test"
import { OmoConfigSchema } from "@oh-my-opencode/omo-config-core"
import { catalogModel, conversation, createScriptedFactsPorts, until } from "./facts.test-support"
import { registerMemoryComponent } from "./index"
import type { FactsPortRequest } from "./facts-child"
import type { ReflectionPortRequest } from "./reflection-child"
import type { MemoryReflectionSeams } from "./reflection-component"
import { createMemoryFixture } from "./test-support"

setDefaultTimeout(process.platform === "win32" ? 60_000 : 20_000)

const fixtures: ReturnType<typeof createMemoryFixture>[] = []
afterEach(() => { for (const created of fixtures.splice(0)) created.cleanup() })

function setup(seams: Partial<MemoryReflectionSeams> = {}) {
  const f = createMemoryFixture({ reflection: { trigger: { step_count: 1, on_compaction: true } } })
  fixtures.push(f)
  const ports = createScriptedFactsPorts()
  let runs = 0
  // The scripted doubles only read the shared child-port request fields (scopes, tool names, retire hooks).
  const createPort = (request: ReflectionPortRequest) => ports.createPort(request as unknown as FactsPortRequest)
  const options = f.options({ reflection: { createPort, createRunId: () => `run-${++runs}`, ...seams } })
  return { f, ports, options }
}

describe("memory reflection wiring", () => {
  test("#given a capable reflection host #when the component registers #then /reflect is added beside the core memory commands", async () => {
    // given
    const { f, options } = setup()
    // when
    const cleanup = await registerMemoryComponent(f.host, options)
    // then
    expect(f.commands.get("reflect")?.description).toBe("Request a memory reflection run now, optionally scoped and focused.")
    await cleanup()
  })

  test("#given a root session with user input past the step threshold #when it goes idle #then one reflection child is launched and the idle hook does not wait for it", async () => {
    // given
    const { f, ports, options } = setup()
    f.addSession("root", { messages: conversation("use tabs", "noted, tabs it is") })
    const cleanup = await registerMemoryComponent(f.host, options)
    await f.prompt("root", "use tabs")
    // when
    await f.idle("root")
    await until(() => ports.children.length === 1)
    await f.idle("root")
    await cleanup()
    // then
    expect(ports.children.map(child => [child.start.prompt.length > 0, child.disposed])).toEqual([[true, true]])
  })

  test("#given a root session without user input this process #when it goes idle #then no reflection child is launched", async () => {
    // given
    const { f, ports, options } = setup()
    f.addSession("root", { messages: conversation("use tabs", "noted, tabs it is") })
    const cleanup = await registerMemoryComponent(f.host, options)
    // when
    await f.idle("root")
    await cleanup()
    // then
    expect(ports.children).toHaveLength(0)
  })
  test("#given memory.reflection.category names a category with an available model #when a reflection launches #then the child runs on that model, not the host default", async () => {
    // given
    const config = OmoConfigSchema.parse({ memory: { reflection: { category: "writing" } }, categories: { writing: { model: "acme/writer" } } })
    const { f, ports, options } = setup({ loadConfig: () => config, catalog: async () => [catalogModel("acme", "large"), catalogModel("acme", "writer")] })
    f.addSession("root", { messages: conversation("use tabs", "noted, tabs it is") })
    const cleanup = await registerMemoryComponent(f.host, options)
    await f.prompt("root", "use tabs")
    // when
    await f.idle("root")
    await until(() => ports.children.length === 1)
    await cleanup()
    // then
    expect(ports.children[0]?.start.model).toMatchObject({ providerID: "acme", id: "writer" })
  })
})
