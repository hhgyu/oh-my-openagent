import path from "node:path"
import type { ToolContext } from "@opencode/plugin/promise/tool"
import type { PermissionDomain } from "@opencode/plugin/promise/permission"
import { hasJoinedPermissionCancellation } from "./effect-permission-api"

export interface ResourcePermission {
  readonly action: string
  readonly resources: readonly string[]
}
export type PermissionAdapter = (input: unknown) => readonly ResourcePermission[]
/** Legacy SDK Promise.assert has one argument and no cancellation guarantee. */
export type LegacyPermissionPort = Pick<PermissionDomain, "assert">
/** The genuine API satisfies this common one-argument surface too. Only its
 * issued provenance unlocks internal options and joining, never structural type. */
export type PermissionPort = LegacyPermissionPort

function record(input: unknown): Record<string, unknown> {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("Expected tool input object")
  return input as Record<string, unknown>
}

/** Only use this for the location that owns the listed closures. No cross-location cwd inference. */
export function locationPermissionAdapters(directory: string): Readonly<Record<string, PermissionAdapter>> {
  if (!path.isAbsolute(directory)) throw new Error("Host location must be absolute")
  const absolute = (value: unknown): string => {
    if (typeof value !== "string" || !value || value.includes("\0")) throw new Error("Expected resource path")
    return path.resolve(directory, value)
  }
  return {
    read: input => {
      const value = record(input)
      // Current public read codec uses path; accept filePath only for explicitly compatible inventories.
      if (value.path !== undefined && value.filePath !== undefined) throw new Error("Ambiguous read path")
      return [{ action: "read", resources: [absolute(value.path ?? value.filePath)] }]
    },
    grep: input => {
      const value = record(input)
      if (typeof value.pattern !== "string" || !value.pattern) throw new Error("Expected grep pattern")
      return [{ action: "read", resources: [absolute(value.path ?? directory)] }, { action: "grep", resources: [value.pattern] }]
    },
  }
}

export async function assertPermissions(port: PermissionPort, context: ToolContext, permissions: readonly ResourcePermission[]) {
  if (!permissions.length) throw new Error("Permission adapter must declare resources")
  for (const permission of permissions) {
    if (!permission.action || !permission.resources.length || permission.resources.some(value => !value)) throw new Error("Invalid resource permission")
    context.signal.throwIfAborted()
    const input = { sessionID: context.sessionID, agent: context.agent, action: permission.action, resources: [...permission.resources],
      source: { type: "tool" as const, messageID: context.messageID, id: context.id } }
    // Options belong ONLY to our issued internal API, never SDK Promise.assert
    // or a structural lookalike of the joined owner.
    if (hasJoinedPermissionCancellation(port)) await port.assert(input, { signal: context.signal })
    else await port.assert(input)
    context.signal.throwIfAborted()
  }
}
