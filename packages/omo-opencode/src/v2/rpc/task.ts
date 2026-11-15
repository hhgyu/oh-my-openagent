import type { Rpc } from "@opencode/plugin"
import { z } from "zod"

const status = z.enum(["pending", "running", "paused", "completed", "error", "cancelled", "interrupted", "lost"])
const entrySchema = z.object({
  taskId: z.string(),
  label: z.string(),
  status,
  phase: z.enum(["pending", "running", "still", "terminal"]),
  statusLabel: z.string(),
  target: z.string(),
  background: z.boolean(),
  parentSessionId: z.string(),
  depth: z.number().int().nonnegative(),
  createdAt: z.string(),
  startedAt: z.string().optional(),
  terminalAt: z.string().optional(),
  detail: z.string().optional(),
  result: z.string().optional(),
})

export const taskStatusSchema = z.object({ sessionID: z.string().min(1), tasks: z.array(entrySchema) })
export type TaskStatusSnapshot = z.infer<typeof taskStatusSchema>
export type TaskStatusEntry = z.infer<typeof entrySchema>
export const TASK_UPDATED_EVENT_TYPE = "rpc.omo.task.updated"
export const taskStatusRpc = {
  id: "omo.task",
  methods: { status: { input: z.object({ sessionID: z.string().min(1) }), output: taskStatusSchema } },
  events: { updated: { schema: taskStatusSchema } },
} satisfies Rpc.PortableDefinition
