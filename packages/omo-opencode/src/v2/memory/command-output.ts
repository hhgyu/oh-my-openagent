import type { Rpc } from "@opencode/plugin"
import { z } from "zod"
import { MEMORY_COMMAND_OUTPUT_EVENT, MEMORY_COMMAND_RPC_ID } from "./command-output-event"

/**
 * Session message IDs of memory command output records. OpenCode 2.2.6 sends every `synthetic` session
 * message to the model as a user message carrying the session message ID (there is no UI-only message
 * kind), so `stripMemoryCommandOutputs` removes these IDs from every model request the memory
 * component sees. The prefix is the marker: it survives a host restart without extra state.
 */
export const MEMORY_COMMAND_OUTPUT_ID_PREFIX = "msg_omo_memory_output_"

/** RPC with no methods: its only member is the ephemeral output event the OmO TUI plugin shows. */
export const memoryCommandRpc = {
  id: MEMORY_COMMAND_RPC_ID,
  methods: {},
  events: {
    [MEMORY_COMMAND_OUTPUT_EVENT]: {
      schema: z.object({
        sessionID: z.string(),
        command: z.string(),
        level: z.enum(["info", "warning", "error"]),
        text: z.string(),
      }),
    },
  },
} satisfies Rpc.PortableDefinition

/** Removes memory command output records from a model request, in place; returns how many were removed. */
export function stripMemoryCommandOutputs(messages: { readonly id?: string }[]): number {
  let removed = 0
  for (let index = messages.length - 1; index >= 0; index--) {
    if (messages[index]?.id?.startsWith(MEMORY_COMMAND_OUTPUT_ID_PREFIX) !== true) continue
    messages.splice(index, 1)
    removed++
  }
  return removed
}
