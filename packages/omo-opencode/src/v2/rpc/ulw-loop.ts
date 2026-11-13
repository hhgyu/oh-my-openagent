import type { Rpc } from "@opencode/plugin"
import { z } from "zod"

export const ulwLoopStatusSchema = z.object({ sessionID: z.string().min(1), active: z.boolean() })
export type UlwLoopStatus = z.infer<typeof ulwLoopStatusSchema>
export const ULW_LOOP_UPDATED_EVENT_TYPE = "rpc.omo.ulw-loop.updated"
export const ulwLoopStatusRpc = {
  id: "omo.ulw-loop",
  methods: { status: { input: z.object({ sessionID: z.string().min(1) }), output: ulwLoopStatusSchema } },
  events: { updated: { schema: ulwLoopStatusSchema } },
} satisfies Rpc.PortableDefinition
