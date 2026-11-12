// Composition of memory reflection inside the memory component (plan S7e + S7f): the owned
// `omo-reflection` child hosting, the parent-side runner and the bind-time crash recovery. Production
// hosts the child only on the same capable host as the facts extractor and the Kibitzer judge (verified
// OpenCode 2.2.6 with the joined Effect session transport) and only when the agent domain can register
// the hidden agent; a supplied `createPort` stands in for that host in tests. Triggers (S7g, see
// `reflection-triggers.ts` and `/reflect`) go through `evaluate`, which is Senpi's
// `runtime.store.evaluate` followed by a detached `runtime.launch` of the run that won the active slot;
// dreams (S7h, see `dream-triggers.ts` and `/dream`) go through `requestDream` and the same launch;
// recovery runs at every bind. Close cancels live children and waits for every tracked run, evaluation
// and recovery to settle.

import type { ReflectionEvent, ReflectionLockProbe, ReservationResult, ReservedRun } from "@oh-my-opencode/memory-core"
import type { OmoConfig } from "@oh-my-opencode/omo-config-core"
import { loadRuntimeConfig } from "../config/runtime"
import type { probeJournalOwner } from "../host/child-journal"
import { createModelCatalog, type CatalogModel } from "../host/model-catalog"
import type { BoundMemorySession } from "./binding"
import { fireDream, type DreamFireOutcome, type DreamRequest, type V2DreamOrigin } from "./dream-fire"
import { resolveDreamTriggerSettings, type DreamTriggerSettings } from "@oh-my-opencode/memory-core/dream-gates"
import type { MemoryLogger } from "./config"
import { turnReport } from "./memory-child-port"
import { kibitzerHostCapable } from "./kibitzer"
import type { MemoryChildPort, MemoryChildTimers } from "./memory-child-port"
import { createReflectionChildHosting, type ReflectionChildHosting, type ReflectionPortRequest } from "./reflection-child"
import { consentedProviders } from "./reflection-consent"
import { resolveReflectionModel } from "./reflection-model"
import { createReflectionRecovery } from "./reflection-recovery"
import { reflectionSettings, reflectionStore, type ReflectionStoreSeams } from "./reflection-run-store"
import { createReflectionRunner } from "./reflection-runner"
import type { MemoryHost } from "./index"

/** Reflection test seams: the child port, model catalog and config, deadline timers and length, liveness probes and store ids. */
export interface MemoryReflectionSeams extends ReflectionStoreSeams {
  /** Unified config for the reflection category; defaults to the runtime config of the bound directory. */
  readonly loadConfig?: (cwd: string) => OmoConfig
  readonly catalog?: () => Promise<readonly CatalogModel[]>
  /** Providers the user configured or authenticated; defaults to the live `provider` + `integration` records. */
  readonly consentedProviders?: () => Promise<ReadonlySet<string>>
  readonly createPort?: (request: ReflectionPortRequest) => MemoryChildPort
  readonly timers?: MemoryChildTimers
  readonly deadlineMs?: number
  readonly probe?: ReflectionLockProbe
  readonly probeOwner?: typeof probeJournalOwner
}

export interface ReflectionComponent {
  readonly hosting: ReflectionChildHosting
  /**
   * Evaluates one trigger event against the identity's reservation store (memory-core
   * `ReflectionReservationStore.evaluate`: journal step accounting, park gate, snapshot capture,
   * reservation). A run that wins the active slot is launched detached and tracked; a pending one is
   * launched by the active run's completion. Returns the reservation result; `null` when nothing fired.
   */
  evaluate(bound: BoundMemorySession, event: ReflectionEvent): Promise<ReservationResult | null>
  /** One dream request (`dream-fire.ts`) through the same reservation store and detached launch. */
  requestDream(bound: BoundMemorySession, origin: V2DreamOrigin, request?: DreamRequest): Promise<DreamFireOutcome>
  /** The dream policy of the bound identity, read from the freshly loaded config like the model category. */
  dreamSettings(bound: BoundMemorySession): DreamTriggerSettings
  /** Bind-time crash recovery; never throws. */
  onBound(bound: BoundMemorySession): Promise<void>
  close(): Promise<void>
}

export function createReflectionComponent(context: MemoryHost, deps: { readonly logger: MemoryLogger; readonly seams?: MemoryReflectionSeams }): ReflectionComponent | undefined {
  const seams = deps.seams ?? {}
  if (seams.createPort === undefined && (!kibitzerHostCapable(context) || context.agent === undefined)) return undefined
  const warn = (message: string, details?: Record<string, unknown>): void => { deps.logger.warn(message, details) }
  const store: ReflectionStoreSeams = {
    ...(seams.createRunId === undefined ? {} : { createRunId: seams.createRunId }),
    ...(seams.now === undefined ? {} : { now: seams.now }),
    ...(seams.launcherIdentity === undefined ? {} : { launcherIdentity: seams.launcherIdentity }),
  }
  const hosting = createReflectionChildHosting({
    host: context, warn,
    ...(seams.createPort === undefined ? {} : { createPort: seams.createPort }),
    ...(seams.timers === undefined ? {} : { timers: seams.timers }),
  })
  const retryRegistration = context.session.hook("retry", event => { hosting.onRetry(event) })
    .then(registration => ({ registration }), (error: unknown) => ({ error }))
  const loadConfig = seams.loadConfig ?? ((cwd: string) => loadRuntimeConfig({ cwd }).config)
  const { model, provider } = context
  const catalog = seams.catalog ?? (model === undefined || provider === undefined ? undefined : () => createModelCatalog({ model, provider }).list())
  const consent = seams.consentedProviders ?? (() => consentedProviders({ provider, integration: context.integration }, warn))
  // Resolved per launch like Native: the category is read from the freshly loaded config, the catalog and provider consent live.
  const resolveModel = async (bound: BoundMemorySession, parentSessionId: string) => {
    const config = loadConfig(bound.directory)
    const category = reflectionSettings(config.memory === undefined ? bound : { settings: config.memory, identity: bound.identity }).category
    const [models, session, consented] = await Promise.all([catalog?.(), context.session.context({ sessionID: parentSessionId }).then(messages => turnReport(messages, 0)).catch(() => undefined), consent()])
    return resolveReflectionModel(category, config, models, session?.model, consented, session?.variant)
  }
  const runner = createReflectionRunner({
    launch: async (bound, input) => {
      const retry = await retryRegistration
      if ("error" in retry) throw retry.error
      return hosting.launch(bound, input)
    },
    warn, resolveModel, ...store, ...(seams.deadlineMs === undefined ? {} : { deadlineMs: seams.deadlineMs }),
  })
  const work = new Set<Promise<unknown>>()
  const cancels = new Set<() => void>()
  let closed = false
  const track = <T>(promise: Promise<T>): Promise<T> => {
    work.add(promise)
    void promise.finally(() => { work.delete(promise) }).catch(() => undefined)
    return promise
  }
  /** Runs `body` with a cancel registry that `close` drains; the registry entries leave with the run. */
  const cancellable = <T>(body: (onCancel: (cancel: () => void) => void) => Promise<T>): Promise<T> => {
    const own = new Set<() => void>()
    const run = body(cancel => {
      if (closed) { cancel(); return }
      own.add(cancel)
      cancels.add(cancel)
    })
    return track(run.finally(() => { for (const cancel of own) cancels.delete(cancel) }))
  }
  const recovery = createReflectionRecovery({
    host: context, warn, ...store,
    ...(seams.probe === undefined ? {} : { probe: seams.probe }),
    ...(seams.probeOwner === undefined ? {} : { probeOwner: seams.probeOwner }),
    runPromoted: (bound, run) => cancellable(onCancel => runner.runPromoted(bound, run, { parentSessionId: bound.sessionID, onCancel })),
  })
  // A reservation taken while closing still launches: `cancellable` cancels it at once, so the
  // runner settles it and releases `active.lock` instead of stranding it until the next bind.
  const launchActive = (bound: BoundMemorySession, run: ReservedRun): void => {
    void cancellable(onCancel => runner.runPromoted(bound, run, { parentSessionId: bound.sessionID, onCancel }))
      .catch((error: unknown) => { warn("memory reflection run failed", { runId: run.runId, error: error instanceof Error ? error.message : String(error) }) })
  }
  const dreamSettings = (bound: BoundMemorySession) => resolveDreamTriggerSettings(loadConfig(bound.directory).memory ?? bound.settings, bound.identity)
  return {
    hosting,
    async evaluate(bound, event) {
      if (closed) return null
      const result = await track(reflectionStore(bound, store).evaluate(bound.sessionID, event))
      if (result?.status === "active") launchActive(bound, result.run)
      return result
    },
    async requestDream(bound, origin, request = {}) {
      if (closed) return { fired: false, rejection: "no_session" }
      return track(fireDream({
        bound, origin, request, settings: dreamSettings(bound), store: reflectionStore(bound, store),
        now: () => (seams.now?.() ?? new Date()).getTime(), launch: run => { launchActive(bound, run) },
      }))
    },
    dreamSettings,
    async onBound(bound) {
      if (closed) return
      await track(recovery.onBound(bound))
    },
    async close() {
      closed = true
      for (const cancel of cancels) cancel()
      cancels.clear()
      hosting.close()
      while (work.size > 0) await Promise.allSettled([...work])
      const retry = await retryRegistration
      if ("registration" in retry) await retry.registration.dispose()
    },
  }
}
