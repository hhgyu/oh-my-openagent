import type { Rpc } from "@opencode/plugin"
import type { DagRunSnapshot } from "@oh-my-opencode/senpi-task/dag"
import { z } from "zod"

const nodeState = z.enum(["pending", "blocked", "scheduled", "running", "paused", "completed", "failed", "cancelled", "skipped"])
const count = z.number().int().nonnegative()
const runSchema = z.object({
  runId: z.string(), runKey: z.string(), name: z.string(),
  status: z.enum(["pending", "running", "paused", "completed", "failed", "cancelled"]),
  counts: z.object({ total: count, pending: count, blocked: count, scheduled: count, running: count,
    paused: count.optional(), completed: count, failed: count, cancelled: count, skipped: count }),
  nodes: z.array(z.object({ id: z.string(), label: z.string().optional(), state: nodeState, taskId: z.string().optional(),
    error: z.object({ code: z.string(), message: z.string() }).optional() })),
})

export const dagStatusSchema = z.object({ sessionID: z.string().min(1), runs: z.array(runSchema) })
export type DagStatus = z.infer<typeof dagStatusSchema>
export const DAG_UPDATED_EVENT_TYPE = "rpc.omo.dag.updated"
export const dagStatusRpc = {
  id: "omo.dag",
  methods: { status: { input: z.object({ sessionID: z.string().min(1) }), output: dagStatusSchema } },
  events: { updated: { schema: dagStatusSchema } },
} satisfies Rpc.PortableDefinition

/** Read-only projection: never send node prompts, outputs or scheduler authority to the UI. */
export function dagStatusSnapshot(sessionID: string, snapshots: readonly DagRunSnapshot[]): DagStatus {
  return { sessionID, runs: snapshots.map(run => ({
    runId: run.runId, runKey: run.runKey, name: run.name, status: run.status, counts: run.counts,
    nodes: run.nodes.map(node => ({ id: node.id, state: node.state,
      ...(node.label === undefined ? {} : { label: node.label }),
      ...(node.taskId === undefined ? {} : { taskId: node.taskId }),
      ...(node.error === undefined ? {} : { error: { code: node.error.code, message: node.error.message } }),
    })),
  })) }
}
