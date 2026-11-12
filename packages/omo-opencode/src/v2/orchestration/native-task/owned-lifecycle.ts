import type { OwnedSessionLifecyclePort, TaskRecord } from "@oh-my-opencode/senpi-task/manager-kernel"
import type { OwnedTaskControl } from "./owned-handle"

export function createOwnedTaskLifecyclePort(options: {
  controls: Map<string, OwnedTaskControl>
  recover(record: TaskRecord): Promise<void>
  closeRetained(record: TaskRecord): Promise<void>
  beforeRetire?(record: TaskRecord, intent: "end" | "detach"): Promise<void>
  releaseControl?(record: TaskRecord, control: OwnedTaskControl): Promise<void>
  beforeDetach(record: TaskRecord): void
  isClosed(record: TaskRecord): Promise<boolean>
  /** Reports a recovered close-path failure with its context; nothing reported here is dropped. */
  report?(message: string, context: Record<string, unknown>): void
}): OwnedSessionLifecyclePort {
  async function control(record: TaskRecord) {
    let current = options.controls.get(record.task_id)
    if (!current) { await options.recover(record); current = options.controls.get(record.task_id) }
    if (!current) throw new Error("Owned cleanup could not reacquire its exact session")
    return current
  }
  /** A failed park is retried as an END only when the host itself says the child is gone: nothing
   * is left to park or restore, and END closes custody on that genuine removal. */
  async function hostRemoved(current: OwnedTaskControl, cause: unknown): Promise<boolean> {
    try { return await current.backend.hostRemoved(current.child) }
    catch (probe) { throw new AggregateError([cause, probe], "Owned child park failed and its host presence is unknown") }
  }
  return {
    async destroy(record, cause) {
      await options.beforeRetire?.(record, cause === "recovery_detach" ? "detach" : "end")
      if (await options.isClosed(record)) {
        // A durable host removal is not a receipt for locally owned registrations.
        // Keep the control until its real observer/policy cleanup has also joined.
        const current = options.controls.get(record.task_id)
        await current?.end()
        if (current) await options.releaseControl?.(record, current)
        options.controls.delete(record.task_id)
        return
      }
      if (cause === "recovery_detach") { const current = await control(record); options.beforeDetach(record); await current.detach(); await options.releaseControl?.(record, current) }
      else {
        const current = options.controls.get(record.task_id)
        if (current) { await current.end(); await options.releaseControl?.(record, current) }
        else await options.closeRetained(record)
      }
      options.controls.delete(record.task_id)
    },
    async suspend(record) {
      await options.beforeRetire?.(record, "detach")
      const current = await control(record)
      options.beforeDetach(record)
      try { await current.detach() }
      catch (cause) {
        if (!(await hostRemoved(current, cause))) throw cause
        options.report?.("owned child was removed by the host; closing its custody instead of parking it", {
          taskId: record.task_id, childSessionId: record.child_session_id, parkFailure: cause instanceof Error ? cause.message : String(cause) })
        try { await current.end() }
        catch (failure) { throw new AggregateError([cause, failure], "Host-removed owned child custody did not close") }
      }
      await options.releaseControl?.(record, current); options.controls.delete(record.task_id)
    },
    async reconcile(record) {
      try {
        await options.recover(record)
        return { task_id: record.task_id, kind: "resumed", reason: "Owned host control reacquired; prior observation coverage remains explicitly uncertain" }
      } catch {
        return { task_id: record.task_id, kind: "deferred", reason: "session_unavailable", retryable: true }
      }
    },
  }
}
