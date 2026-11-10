import { z } from "zod"

const effect = z.enum(["allow", "deny", "ask"])
const modelEntry = z.union([z.string(), z.object({ model: z.string(), reasoning: z.string().optional() })])
export const agentOverrideSchema = z.object({
  model: z.string().optional(), models: z.array(modelEntry).optional(),
  reasoning: z.string().optional(), variant: z.string().optional(),
  prompt: z.string().optional(), prompt_append: z.string().optional(),
  description: z.string().optional(), displayName: z.string().optional(),
  mode: z.enum(["primary", "subagent", "all"]).optional(),
  color: z.string().optional(), disable: z.boolean().optional(),
  temperature: z.number().min(0).max(2).optional(),
  permission: z.record(z.string(), z.union([effect, z.record(z.string(), effect)])).optional(),
  permissions: z.array(z.object({ action: z.string(), resource: z.string(), effect })).optional(),
  tools: z.record(z.string(), z.boolean()).optional(),
  disallowed_tools: z.array(z.string()).optional(),
})
export type AgentOverride = z.infer<typeof agentOverrideSchema>
export type AgentsConfig = { agents: Record<string, AgentOverride>; disabled_agents: string[] }
