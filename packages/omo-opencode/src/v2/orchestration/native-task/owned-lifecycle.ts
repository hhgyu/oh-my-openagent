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
}): OwnedSessionLifecyclePort {
  async function control(record: TaskRecord) {
    let current = options.controls.get(record.task_id)
    if (!current) { await options.recover(record); current = options.controls.get(record.task_id) }
    if (!current) throw new Error("Owned cleanup could not reacquire its exact session")
    return current
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
    async suspend(record) { await options.beforeRetire?.(record, "detach"); const current = await control(record); options.beforeDetach(record); await current.detach(); await options.releaseControl?.(record, current); options.controls.delete(record.task_id) },
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
