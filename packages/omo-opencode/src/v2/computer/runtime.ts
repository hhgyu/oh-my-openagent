// One session's computer-use implementation: the desktop service over its engine child, the session handle and the
// shared tools' `execute`. The component imports this module on the first `/computer`, tool call or eval cell call
// only, so a session that never drives the desktop loads none of it (Native #9113). Creating it starts nothing.

import type { PermissionDeniedData } from "@oh-my-opencode/senpi-desktop-protocol"
import type { ChildFactory, ExecuteTool } from "@oh-my-opencode/senpi-desktop-service"
import {
  ComputerHandle,
  type ComputerSettings,
  type ControlConfirmRequest,
  createComputerActionsTool,
  createComputerTool,
} from "@oh-my-opencode/senpi-desktop-tool"
import { TrackedDesktopService } from "./tracked-desktop-service"

export interface ComputerSessionRuntimeOptions {
  readonly settings: ComputerSettings
  readonly createChild: ChildFactory
  readonly confirmControl: (request: ControlConfirmRequest) => Promise<boolean>
  readonly onPermissionRequired?: (permission: Pick<PermissionDeniedData, "permission" | "app">) => void
}

// `tool.<name>()` inside `run` code is Native's host tool pipeline; an OpenCode 2 plugin has no API that runs
// another host tool under its own permission rules, so it is refused instead of bypassing them.
const refuseHostTools: ExecuteTool = (toolName) =>
  Promise.reject(
    new Error(
      `tool.${toolName}() is not available inside computer run code on OpenCode 2; call ${toolName} directly, outside the run.`,
    ),
  )

export function createComputerSessionRuntime(options: ComputerSessionRuntimeOptions) {
  const service = new TrackedDesktopService({
    createChild: options.createChild,
    ...(options.onPermissionRequired === undefined ? {} : { onPermissionRequired: options.onPermissionRequired }),
  })
  const handle = new ComputerHandle({ service, settings: () => options.settings })
  const deps = { handle, executeTool: refuseHostTools, confirmControl: options.confirmControl }
  return {
    handle,
    service,
    tools: { computer: createComputerTool(deps), computer_actions: createComputerActionsTool(deps) },
  }
}

export type ComputerSessionRuntime = ReturnType<typeof createComputerSessionRuntime>
