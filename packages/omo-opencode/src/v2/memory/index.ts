import { RecallCorpusCache, isAutoAgentValue, resolveAutoIdentity, resolveMemoryIdentity } from "@oh-my-opencode/memory-core"
import type { OmoMemorySettings } from "@oh-my-opencode/omo-config-core"
import type * as Plugin from "@opencode/plugin/promise/plugin"
import type { Registration } from "@opencode/plugin/promise/registration"
import type { RpcRegistration } from "@opencode/plugin/promise/rpc"
import { createMemoryBinder, describeError, type BoundMemorySession } from "./binding"
import { createMemoryCommands } from "./commands"
import { memoryCommandRpc, stripMemoryCommandOutputs } from "./command-output"
import { MEMORY_COMMAND_OUTPUT_EVENT } from "./command-output-event"
import { consoleMemoryLogger, loadMemorySettings, memoryComponentEnabled, resolveSafeMemoryRoot, type MemoryEnv, type MemoryLogger } from "./config"
import { createMemoryJournal } from "./journal"
import { createMemoryProjection } from "./projection"
import { createRecallCollector, fileRecallStores, type RecallStores } from "./recall"
import { createRecallDelivery } from "./recall-delivery"
import { createSessionMetadataStore } from "./session-metadata"
import { loadKibitzerPersona } from "@oh-my-opencode/memory-core"
import { createKibitzerComponent, kibitzerCategoryModel, kibitzerHostCapable, registerKibitzerAgent, type KibitzerComponent, type KibitzerSeams } from "./kibitzer"
import { loadRuntimeConfig } from "../config/runtime"
import { registerFactsAgent } from "./facts-agent"
import { createFactsComponent, type MemoryFactsSeams } from "./facts-component"
import { createMemoryTools, MEMORY_APPLY_PATCH_TOOL_NAME, MEMORY_TOOL_NAME } from "./tools"
import { registerReflectionAgent } from "./reflection-agent"
import { createReflectionComponent, type MemoryReflectionSeams } from "./reflection-component"
import { createReflectionTriggers } from "./reflection-triggers"
import { narrowPrivateTools, type PrivateToolRequest } from "./private-tools"
import { createReflectCommand } from "./reflect-command"
import { underSystemTokenPressure } from "./dream-budget"
import { createDreamCommand } from "./dream-command"
import { createDreamTriggers } from "./dream-triggers"
import { createV2MemoryMaintenance, type MemoryMaintenanceSeams } from "./maintenance"
import { createDoctorCommand } from "./doctor-command"
import { createSleeptimeCommand } from "./sleeptime-command"
import { createPeopleCommand } from "./people-command"
import { createPalaceCommand } from "./palace-command"
import { createMemoryStatusRpc } from "./status-rpc"
import { createMemorySyncRuntime } from "./sync/runtime"
import { registerMemorySyncRpc } from "./sync/rpc"
import type { MemorySyncSeams } from "./sync/ports"
import { observeAcceptedCompactions } from "./compaction-events"
import { createAcceptedTurns } from "./accepted-turns"

export { MEMORY_BINDING_KEY } from "./binding"
export { MEMORY_PART_MARKER, PROJECTION_PIN_KEY } from "./projection"
export { RECALL_PART_MARKER } from "./recall-delivery"
export { MEMORY_COMMAND_NAMES, MEMORY_COMMAND_OUTPUT_KEY } from "./commands"
export { MEMORY_COMMAND_OUTPUT_ID_PREFIX } from "./command-output"

export type MemoryHost = Pick<Plugin.Context, "session" | "tool" | "options" | "location" | "event"> & Partial<Pick<Plugin.Context, "app" | "agent" | "command" | "rpc" | "model" | "provider" | "integration">>

export interface MemoryComponentOptions {
  /** Environment for `OMO_MEMORY_HOME` and identity resolution; defaults to `process.env`. */
  readonly env?: MemoryEnv
  /** Home directory the `~/.omo` reservation is checked against; defaults to `os.homedir()`. */
  readonly home?: string
  readonly now?: () => number
  readonly loadSettings?: (cwd: string) => OmoMemorySettings
  readonly logger?: MemoryLogger
  readonly lockWaitTimeoutMs?: number
  readonly lockRetryDelayMs?: number
  readonly recallStores?: RecallStores
  /**
   * Kibitzer test seam. Production runs the judge only on a host that can own its child (verified
   * OpenCode 2.2.6 with the joined Effect session transport); a supplied `createPort` stands in for it.
   */
  readonly kibitzer?: KibitzerSeams
  /** Facts extractor seams (child port, model catalog, deadline timers). */
  readonly facts?: MemoryFactsSeams
  /** Reflection seams (child port, timers, deadline, liveness probes, run ids). */
  readonly reflection?: MemoryReflectionSeams
  /** Repo maintenance seams (delay, interval, packing threshold, clock). */
  readonly maintenance?: MemoryMaintenanceSeams
  /** Memory sync seams (the lazily loaded sync host). */
  readonly sync?: MemorySyncSeams
}

/**
 * OpenCode 2 memory component (plan phases P1 + P2). Senpi -> OpenCode mapping:
 * - session_start binding entry -> lazy bind on first use from `session.get`, recorded in session metadata;
 * - before_agent_start systemPrompt block -> one tagged system part per model request (`session.hook("context")`);
 * - registerTool memory -> `tool.transform` adding `memory` and `memory_apply_patch`;
 * - recall drain message -> one tagged recall system part, fed by `prompt` and `execute.before` collection;
 * - resident Kibitzer judge (P3) -> one owned child per bound root session (see `./kibitzer`): candidates
 *   are judged there and only its accepted nudges reach the recall part.
 * - session_start / agent_settled transcript journal -> reconcile at first bind and on `experimental.idle`
 *   (see `./journal`);
 * - registerCommand memory suite -> `command.transform` adding the host-neutral memory-core commands,
 *   output shown through the `rpc.omo-memory.command.output` event (OmO TUI dialog) and recorded as a
 *   `resume: false` synthetic message that the `context`/`compaction` hooks strip from model requests
 *   (see `./commands`, `./command-output`);
 * - facts queue / extractor (`facts-wiring.ts`) -> `prompt` marks real user input, `experimental.idle` enqueues
 *   and debounces, an owned hidden `omo-facts` child records through `record_fact`, the parent applies, and the
 *   next bind enqueues a final delta and recovers stranded runs (see `./facts`).
 * - reflection worker -> an owned hidden `omo-reflection` child editing through four private tools, a parent
 *   runner that validates and merges its branch, and bind-time crash recovery (see `./reflection-component`);
 *   step-count and compaction triggers on `experimental.idle` / `session.compaction.ended` (see `./reflection-triggers`)
 *   and `/reflect` (see `./reflect-command`); dreams through the same runner with the hidden `omo-dream` agent,
 *   an idle timer and a bind-time pressure origin (see `./dream-triggers`) and `/dream` (see `./dream-command`);
 *   the read-side commands `/doctor`, `/sleeptime`, `/people` (no `--ask`) and `/palace` over the memory-core
 *   doctor and palace (see `./insight-commands`).
 * - session_start memory maintenance -> the memory-core scheduler (unref'd delayed timer) scheduled at bind and
 *   disposed on close (see `./maintenance`).
 * - per-session sync runner acquire -> one acquire per distinct bound repo, released in cleanup, with the
 *   runner, account source and Loro engine loaded lazily (see `./sync/runtime`); the `omo.memory.sync` RPC
 *   (see `./sync/rpc`) and the `omo.memory` status method plus `updated` event (see `./status-rpc`).
 * Nothing calls `session.prompt`; subagent children never bind; Kibitzer input goes through the owned
 * session backend's gated admission paths.
 */
export async function registerMemoryComponent(context: MemoryHost, options: MemoryComponentOptions = {}): Promise<() => Promise<void>> {
  const loadSettings = options.loadSettings ?? loadMemorySettings
  const initialSettings = loadSettings(context.location.directory)
  if (!memoryComponentEnabled(initialSettings, context.options)) return async () => {}
  const logger = options.logger ?? consoleMemoryLogger
  const now = options.now ?? Date.now
  const metadata = createSessionMetadataStore(context.session)
  let closed = false
  // The journal is created after the binder it reads; a bind before that has nothing to catch up.
  let onBound: ((bound: BoundMemorySession) => void) | undefined
  const env = options.env ?? process.env
  const binder = createMemoryBinder({
    session: context.session, metadata, env, now, loadSettings, logger,
    ...(options.home === undefined ? {} : { home: options.home }),
    onBound: bound => { if (!closed) onBound?.(bound) },
  })
  const stores = options.recallStores ?? fileRecallStores
  const projection = createMemoryProjection({ binder, metadata, now, logger })
  const corpusCache = new RecallCorpusCache({ shared: true })
  const seams = options.kibitzer
  // The persona is read BEFORE any agent transform: a throw inside a host transform makes OpenCode
  // disable the whole plugin. A missing persona disables only the judge (no recall nudges).
  const persona = (() => {
    if (seams?.createPort !== undefined || !kibitzerHostCapable(context)) return undefined
    try { return loadKibitzerPersona() } catch (error) {
      logger.warn("kibitzer disabled: persona asset unavailable", { error: describeError(error) })
      return null
    }
  })()
  const kibitzer: KibitzerComponent | undefined = seams?.createPort !== undefined || (kibitzerHostCapable(context) && persona !== null)
    ? createKibitzerComponent({ host: context, binder, stores, corpusCache, logger, now, ...seams })
    : undefined
  const factsParts = createFactsComponent(context, { binder, logger, now, loadSettings, ...(options.facts === undefined ? {} : { seams: options.facts }) })
  const facts = factsParts?.facts
  const factsHosting = factsParts?.hosting
  const factsPersona = factsParts?.persona
  const reflection = createReflectionComponent(context, { logger, ...(options.reflection === undefined ? {} : { seams: options.reflection }) })
  const isReflectionSession = (sessionID: string): boolean => reflection?.hosting.isReflectionSession(sessionID) === true
  // The reflection hosting runs first: a reflection child keeps only its four tools; every other session loses all child-only tools.
  const privateToolOwners = [reflection?.hosting.onContext, factsHosting?.onContext, kibitzer?.narrowTools]
  const narrowRequestTools = (value: PrivateToolRequest): boolean => narrowPrivateTools(value, privateToolOwners)
  const isOwnedSession = (sessionID: string): boolean => kibitzer?.isKibitzerSession(sessionID) === true || facts?.isFactsSession(sessionID) === true || isReflectionSession(sessionID)
  const collector = createRecallCollector({ binder, stores, corpusCache, logger, ...(kibitzer === undefined ? {} : { judge: kibitzer }) })
  const delivery = createRecallDelivery({ binder, stores, collector, logger })
  const userTurns = createAcceptedTurns(binder, logger)
  const journal = createMemoryJournal({ binder, session: context.session, logger, isOwnedSession })
  const hasUserActivity = userTurns.hasActivity
  const triggers = reflection === undefined ? undefined : createReflectionTriggers({
    resolve: sessionID => binder.resolve(sessionID), session: context.session, logger, hasUserActivity, isOwnedSession,
    evaluate: (bound, event) => reflection.evaluate(bound, event),
  })
  const dreams = reflection === undefined ? undefined : createDreamTriggers({
    resolve: sessionID => binder.resolve(sessionID), session: context.session, logger, hasUserActivity, isOwnedSession,
    request: (bound, origin) => reflection.requestDream(bound, origin), settings: bound => reflection.dreamSettings(bound), pressure: underSystemTokenPressure,
  })
  const maintenance = createV2MemoryMaintenance(logger, options.maintenance)
  // Sync acquires once per distinct bound repo and loads its runtime lazily (see `./sync/runtime`); an
  // unsafe memory root binds nothing, so it gets no sync and no `omo.memory.sync` RPC either.
  const memoryRoot = resolveSafeMemoryRoot(env, context.location.directory, options.home)
  const statusRpc = createMemoryStatusRpc({ syncStatus: async repo => sync?.status(repo), logger })
  const sync = !memoryRoot.ok ? undefined : createMemorySyncRuntime({
    initialBinding: {
      settings: initialSettings,
      identity: (isAutoAgentValue(initialSettings.agent)
        ? resolveAutoIdentity(context.location.directory, { ...env }, initialSettings.auto_identity)
        : resolveMemoryIdentity(initialSettings.agent, context.location.directory, { ...env })).id,
    },
    env, memoryRoot: memoryRoot.root, logger, onRepoChanged: repo => statusRpc.refreshRepo(repo),
    ...(options.sync === undefined ? {} : { seams: options.sync }),
  })
  onBound = bound => {
    maintenance.onBound(bound)
    statusRpc.onBound(bound)
    sync?.onBound(bound)
    void journal.onBound(bound).then(() => facts?.onBound(bound)).then(() => reflection?.onBound(bound)).then(() => dreams?.onBound(bound))
  }
  let outputEvents: RpcRegistration<typeof memoryCommandRpc>["events"] | undefined
  const commands = context.command === undefined ? undefined : createMemoryCommands({
    display: async output => { await outputEvents?.emit(MEMORY_COMMAND_OUTPUT_EVENT, { ...output }) },
    binder, session: context.session, logger, isClosed: () => closed,
    bustPromptCache: sessionID => { projection.markCompacted(sessionID) },
    ...(facts === undefined ? {} : { factsRetry: (sessionID: string) => facts.retry(sessionID) }),
    extraCommands: [
      ...(reflection === undefined ? [] : [
        createReflectCommand((bound, event) => reflection.evaluate(bound, event)),
        createDreamCommand({ request: (bound, request) => reflection.requestDream(bound, "manual", request), settings: bound => reflection.dreamSettings(bound) }),
      ]),
      createDoctorCommand({ now }), createSleeptimeCommand(), createPeopleCommand(), createPalaceCommand(),
    ],
  })
  const tools = createMemoryTools({
    binder, userTurns: userTurns.turns,
    ...(options.lockWaitTimeoutMs === undefined ? {} : { lockWaitTimeoutMs: options.lockWaitTimeoutMs }),
    ...(options.lockRetryDelayMs === undefined ? {} : { lockRetryDelayMs: options.lockRetryDelayMs }),
  })

  const registrations: Registration[] = []
  let disposal: Promise<void> | undefined
  const cleanup = (): Promise<void> => {
    disposal ??= (async () => {
      closed = true
      const results = await Promise.allSettled(registrations.map(registration => registration.dispose()))
      await collector.idle()
      await userTurns.settled()
      await Promise.allSettled([journal.settled(), commands?.settled()])
      if (facts !== undefined) results.push(...await Promise.allSettled([facts.close()]))
      // Triggers stop before the component closes, so no evaluation reserves a run after its children die.
      if (triggers !== undefined) results.push(...await Promise.allSettled([triggers.close()]))
      if (dreams !== undefined) results.push(...await Promise.allSettled([dreams.close()]))
      if (reflection !== undefined) results.push(...await Promise.allSettled([reflection.close()]))
      if (kibitzer !== undefined) results.push(...await Promise.allSettled([kibitzer.close()]))
      results.push(...await Promise.allSettled([maintenance.close()]))
      statusRpc.close()
      await statusRpc.settled()
      // Every acquired repo is released before the binder forgets the sessions that bound it.
      if (sync !== undefined) results.push(...await Promise.allSettled([sync.close()]))
      await metadata.settled()
      binder.clear()
      projection.clear()
      journal.clear()
      collector.clear()
      const failures = results.filter((result): result is PromiseRejectedResult => result.status === "rejected")
      if (failures.length > 0) throw new AggregateError(failures.map(failure => failure.reason), "Memory component cleanup failed")
    })()
    return disposal
  }
  try {
    if (context.event !== undefined) registrations.push(userTurns.register(context.event))
    registrations.push(observeAcceptedCompactions(context.event, async sessionID => {
      if (closed || isOwnedSession(sessionID)) return
      triggers?.onCompaction(sessionID)
      const bound = await binder.resolve(sessionID)
      // V2 holds accepted Kibitzer nudges only in this pending store; the resident sidecar survives.
      if (bound !== undefined && !closed) await stores.pending(bound).delete(sessionID)
    }, logger))
    registrations.push(await context.session.hook("prompt", input => {
      if (closed) return
      if (isOwnedSession(input.sessionID)) return
      dreams?.onPrompt(input.sessionID)
      facts?.onPrompt(input.sessionID)
      kibitzer?.onPrompt(input.sessionID, input.prompt.text)
      collector.observePrompt(input.sessionID, input.prompt.text)
    }))
    registrations.push(await context.tool.hook("execute.before", event => {
      if (closed) return
      kibitzer?.onToolBefore(event)
      if (isOwnedSession(event.sessionID) || event.tool === MEMORY_TOOL_NAME || event.tool === MEMORY_APPLY_PATCH_TOOL_NAME) return
      collector.observeToolInput(event.sessionID, event.input)
    }))
    if (kibitzer !== undefined) {
      const judge = kibitzer
      registrations.push(await context.tool.hook("execute.after", event => {
        if (closed) return
        judge.onToolAfter(event.status === "completed"
          ? { sessionID: event.sessionID, tool: event.tool, id: event.id, status: event.status, result: event.result }
          : { sessionID: event.sessionID, tool: event.tool, id: event.id, status: event.status, error: event.error })
      }))
      if (context.agent !== undefined) {
        const directory = context.location.directory
        registrations.push(await registerKibitzerAgent(context.agent, {
          model: () => kibitzerCategoryModel(loadRuntimeConfig({ cwd: directory }).config, loadSettings(directory).recall.category),
          warn: message => logger.warn(message),
          ...(typeof persona === "string" ? { persona: () => persona } : {}),
        }))
      }
    }
    registrations.push(await context.session.hook("context", async value => {
      // Command output records are for the user; they are dropped from every request, the judge's too.
      stripMemoryCommandOutputs(value.messages)
      if (closed || narrowRequestTools(value) || kibitzer?.onContext(value) === true) return
      try {
        await projection.onContext(value)
        await delivery.onContext(value)
        await userTurns.onContext(value)
      } catch (error) {
        logger.warn("memory context injection skipped", { sessionID: value.sessionID, error: describeError(error) })
      }
    }))
    registrations.push(await context.session.hook("compaction", value => {
      stripMemoryCommandOutputs(value.messages)
      // A compaction request offers `tools` too: the same child-only exposure rules as the context hook.
      narrowRequestTools(value)
      projection.markCompacted(value.sessionID)
      dreams?.onCompaction(value.sessionID)
    }))
    registrations.push(await context.session.hook("experimental.idle", async value => {
      if (closed) return
      await journal.onIdle(value.sessionID)
      statusRpc.refreshSession(value.sessionID)
      // A write during this turn may have seeded a repo that was bound before it existed.
      sync?.onSettled()
      // Detached: evaluates after this reconcile counted the turn's steps, never blocks the idle edge.
      if (!closed) triggers?.onIdle(value.sessionID)
      if (!closed) dreams?.onIdle(value.sessionID)
      await facts?.onIdle(value.sessionID)
    }))
    if (facts !== undefined && factsPersona !== undefined && context.agent !== undefined) {
      registrations.push(await registerFactsAgent(context.agent, factsPersona))
    }
    if (reflection !== undefined && context.agent !== undefined) registrations.push(await registerReflectionAgent(context.agent))
    if (context.rpc !== undefined) {
      registrations.push(await statusRpc.register(context.rpc))
      if (sync !== undefined) registrations.push(await registerMemorySyncRpc(context.rpc, sync))
    }
    if (commands !== undefined && context.command !== undefined) {
      if (context.rpc !== undefined) {
        const registration = await context.rpc.register(memoryCommandRpc, {})
        registrations.push(registration)
        outputEvents = registration.events
      }
      const definitions = commands.definitions
      registrations.push(await context.command.transform(editor => { for (const definition of definitions) editor.add(definition) }))
    }
    const [memoryTool, applyPatchTool] = tools
    const judgeTools = kibitzer?.tools(memoryTool)
    const factsTool = factsHosting?.tool()
    const reflectionTools = reflection?.hosting.tools() ?? []
    registrations.push(await context.tool.transform(editor => {
      if (judgeTools === undefined) editor.add(memoryTool)
      else for (const tool of judgeTools) editor.add(tool)
      editor.add(applyPatchTool)
      if (factsTool !== undefined) editor.add(factsTool)
      for (const tool of reflectionTools) editor.add(tool)
    }))
  } catch (error) {
    try { await cleanup() } catch (cleanupError) { throw new AggregateError([error, cleanupError], "Memory registration and rollback failed") }
    throw error
  }
  return cleanup
}
