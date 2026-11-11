import { afterEach, describe, expect, test } from "bun:test"
import { OmoMemorySettingsSchema } from "@oh-my-opencode/omo-config-core"
import type { CommandDefinition } from "@opencode/plugin/promise/command"
import type { BoundMemorySession } from "./binding"
import type { MemoryCommandOutputEvent } from "./command-output-event"
import { MEMORY_COMMAND_OUTPUT_ID_PREFIX } from "./command-output"
import { createMemoryCommands, MEMORY_COMMAND_OUTPUT_KEY } from "./commands"
import { createReflectCommand } from "./reflect-command"
import { reflectionStore } from "./reflection-run-store"
import { createBoundIdentity } from "./reflection.test-support"
import type { SyntheticPost } from "./test-support"

const cleanups: (() => void)[] = []
afterEach(() => { for (const cleanup of cleanups.splice(0)) cleanup() })

function setup(reflection: Record<string, unknown> = {}) {
  const identity = createBoundIdentity()
  cleanups.push(identity.cleanup)
  const bound: BoundMemorySession = { ...identity.bound, settings: OmoMemorySettingsSchema.parse({ reflection }) }
  let runs = 0
  const store = reflectionStore(bound, { createRunId: () => `run-${++runs}` })
  const displayed: MemoryCommandOutputEvent[] = []
  const synthetics: SyntheticPost[] = []
  const commands = createMemoryCommands({
    binder: { resolve: async sessionID => (sessionID === bound.sessionID ? bound : undefined), forget: () => undefined, clear: () => undefined },
    session: { synthetic: async (input: SyntheticPost) => { synthetics.push(input); return { id: "syn" } } } as never,
    logger: { warn: () => undefined }, isClosed: () => false, bustPromptCache: () => undefined,
    display: async output => { displayed.push(output) },
    newOutputID: () => `${MEMORY_COMMAND_OUTPUT_ID_PREFIX}${synthetics.length}`,
    extraCommands: [createReflectCommand((target, event) => store.evaluate(target.sessionID, event))],
  })
  const definition = commands.definitions.find(entry => entry.name === "reflect")
  const reflect = async (text: string, sessionID = bound.sessionID) => {
    if (definition === undefined) throw new Error("/reflect is not registered")
    await definition.execute({ sessionID, prompt: { text }, delivery: "steer" } as unknown as Parameters<CommandDefinition["execute"]>[0])
    await commands.settled()
  }
  return { bound, store, displayed, synthetics, reflect }
}

describe("/reflect", () => {
  test("#given a bound session and an idle identity #when /reflect runs with a focus #then a manual run is reserved and reported through the output event and a stripped record", async () => {
    // given
    const { bound, store, displayed, synthetics, reflect } = setup()
    // when
    await reflect("--recent 3 tabs over spaces")
    // then
    expect(displayed).toEqual([{ sessionID: bound.sessionID, command: "reflect", level: "info", text: `reflection run run-1 reserved (recent 3; focus "tabs over spaces"); it runs in the background` }])
    expect(synthetics.map(post => [post.id?.startsWith(MEMORY_COMMAND_OUTPUT_ID_PREFIX), post.resume, post.metadata?.[MEMORY_COMMAND_OUTPUT_KEY]])).toEqual([[true, false, "reflect"]])
    const active = await store.readState()
    expect(active.active?.request).toMatchObject({ trigger: "manual", focus: "tabs over spaces", recentN: 3, conversationIds: [bound.sessionID] })
  })

  test("#given a reflection run already active #when /reflect runs #then the request is queued as the pending run instead of launching", async () => {
    // given
    const { store, displayed, reflect } = setup()
    await store.tryReserve({ trigger: "step-count", conversationIds: ["other"], snapshots: [] })
    // when
    await reflect("naming")
    // then
    expect(displayed.map(output => [output.level, output.text])).toEqual([
      ["info", `reflection request queued as run-2 (focus "naming"); a run is already active and this request runs next`],
    ])
    const state = await store.readState()
    expect([state.active?.runId, state.pending?.runId, state.pending?.request.trigger]).toEqual(["run-1", "run-2", "manual"])
  })

  test("#given reflection disabled, a bad --recent or an unbound session #when /reflect runs #then it refuses with an error and reserves nothing", async () => {
    // given
    const disabled = setup({ enabled: false })
    const enabled = setup()
    // when
    await disabled.reflect("")
    await enabled.reflect("--recent zero")
    await enabled.reflect("", "unbound")
    // then
    expect([...disabled.displayed, ...enabled.displayed].map(output => [output.level, output.text])).toEqual([
      ["error", "/reflect failed: reflection is disabled; set reflection.enabled to true in your omo config to enable it"],
      ["error", "/reflect failed: --recent expects a positive integer, for example /reflect --recent 5"],
      ["error", "/reflect failed: memory is not bound to this session; start a session with memory enabled and retry"],
    ])
    expect([(await disabled.store.readState()).active, (await enabled.store.readState()).active]).toEqual([undefined, undefined])
  })
})
