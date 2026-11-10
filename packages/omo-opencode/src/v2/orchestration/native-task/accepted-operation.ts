import type { ToolContext } from "@opencode/plugin/promise/tool"

/** Copied SDK primitives, never a retained ToolContext or a synthetic permission identity. */
export type NativeOperationSource = Readonly<Pick<ToolContext, "sessionID" | "agent" | "messageID" | "id">>
type Progress = ToolContext["progress"]
export type NativeSendWorkFailure = Readonly<{
  source: NativeOperationSource
  phase: "sending" | "late"
  reason: string
  originalOutcomeJSON?: string
}>

/** Component-owned work only. A task receipt alone never waits for background TERMINAL. */
export function createAcceptedOperationRegistry() {
  const pending = new Set<Promise<unknown>>()
  const owners = new Set<() => void>()
  const resources = new Set<() => void | Promise<void>>()
  const failures: NativeSendWorkFailure[] = []
  const reportedFailures = new Set<NativeSendWorkFailure>()
  let stopped = false
  function track<T>(work: Promise<T>): Promise<T> {
    pending.add(work)
    void work.finally(() => pending.delete(work)).catch(() => {})
    return work
  }
  return {
    track,
    add(stop: () => void) {
      if (stopped) throw Error("Accepted operation registry is retiring")
      owners.add(stop)
      return () => owners.delete(stop)
    },
    cleanup(close: () => void | Promise<void>) { resources.add(close); return () => resources.delete(close) },
    failure(failure: NativeSendWorkFailure) { failures.push(Object.freeze({ ...failure })) },
    failureHistory(): readonly NativeSendWorkFailure[] { return Object.freeze([...failures]) },
    stop() {
      stopped = true
      const errors: unknown[] = []
      for (const stop of owners) try { stop() } catch (error) { errors.push(error) }
      if (errors.length) throw new AggregateError(errors, "Accepted operation reporting cleanup incomplete")
    },
    async join() {
      // A settlement may enqueue its original continuation. Drain to a fixed point.
      while (pending.size) await Promise.allSettled([...pending])
      const errors: unknown[] = []
      for (const close of [...resources]) {
        try { await close(); resources.delete(close) } catch (error) { errors.push(error) }
      }
      const resourceErrors = errors.length
      for (const failure of failures) if (failure.phase === "late" && !reportedFailures.has(failure)) {
        reportedFailures.add(failure); errors.push(failure)
      }
      if (errors.length) throw new AggregateError(errors, resourceErrors ? "Accepted operation resource cleanup incomplete" : "Accepted Native late outcome failed")
    },
    diagnostics() { return { pending: pending.size, owners: owners.size, resources: resources.size, stopped } },
  }
}

export function createAcceptedOperationLifetime(options: {
  registry: ReturnType<typeof createAcceptedOperationRegistry>
  source: NativeOperationSource
  assertAction(): void
  assertLifetime(): void
  acceptedSignal: AbortSignal
  reportingSignal: AbortSignal
  progress?: Progress
}) {
  const { registry, assertAction: assertOriginalAction, assertLifetime, source: originalSource, reportingSignal } = options
  let live = true, sink: Progress | undefined = options.progress
  let bodyOpen = true
  const progressWork = new Set<Promise<void>>()
  const progressErrors: unknown[] = []
  const stops = new Set<() => void>()
  let reportingJoined = false
  const remove = registry.add(() => { stopReporting(); for (const stop of stops) stop() })
  const source = Object.freeze({ ...originalSource })
  const hasProgress = sink !== undefined
  function stopReporting() { live = false; sink = undefined; reportingSignal.removeEventListener("abort", stopReporting) }
  function closeReporting() { bodyOpen = false; stopReporting() }
  function releaseIfIdle() { if (!live && reportingJoined && !stops.size) remove() }
  reportingSignal.addEventListener("abort", stopReporting, { once: true })
  if (reportingSignal.aborted) stopReporting()
  function assertAction() {
    if (!live) throw Error("Native operation callback is closed")
    assertOriginalAction()
  }
  return {
    source,
    hasProgress,
    reportingSignal,
    assertAction,
    assertLifetime,
    assertBodyContinuation() { if (!bodyOpen) throw Error("Original Native body has returned"); assertLifetime() },
    track: registry.track,
    retainSendWork(work: Promise<unknown>, phase: "sending" | "late", originalOutcome: () => string | undefined) {
      registry.track(work)
      void work.catch(error => registry.failure({ source, phase,
        reason: error instanceof Error ? error.message : String(error), originalOutcomeJSON: originalOutcome(),
      }))
    },
    cleanup: registry.cleanup,
    onStop(stop: () => void) { stops.add(stop); return () => { stops.delete(stop); releaseIfIdle() } },
    progress(update: Parameters<Progress>[0]): void {
      if (!live || !sink) return
      try { assertAction() } catch (error) { progressErrors.push(error); stopReporting(); return }
      let work: Promise<void>
      try { work = sink(update) } catch (error) { progressErrors.push(error); return }
      progressWork.add(work)
      registry.track(work)
      void work.then(() => progressWork.delete(work), error => { progressErrors.push(error); progressWork.delete(work) })
    },
    closeReporting,
    async joinReporting() { while (progressWork.size) await Promise.allSettled([...progressWork]); reportingJoined = true; releaseIfIdle() },
    diagnostics() { return { live, bodyOpen, progressPending: progressWork.size, progressErrors: [...progressErrors], sendFailures: registry.failureHistory().filter(failure => failure.source === source) } },
  }
}

export type NativeOperationLifetime = ReturnType<typeof createAcceptedOperationLifetime>
