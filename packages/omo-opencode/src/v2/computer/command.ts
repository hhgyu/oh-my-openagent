import {
  COMPUTER_COMMAND_USAGE,
  COMPUTER_SKILL_NAME,
  type ComputerSettings,
  runComputerCommand,
} from "@oh-my-opencode/senpi-desktop-tool/registration"
import type { MemoryCommandOutputLevel } from "../memory/command-output-event"
import { describeInstalledEngine, type EngineLocatorOptions, resolveInstalledEngine } from "./engine"
import { describeEnginePermissions } from "./engine-permissions"
import type { SessionRuntimes } from "./session-runtimes"

export const COMPUTER_COMMAND_NAME = "computer"
export const COMPUTER_COMMAND_DESCRIPTION =
  "Computer use (experimental): on, off, status, stop, or resume (stop and resume are user-only)"

export type ComputerSkillState = { readonly kind: "contributed" } | { readonly kind: "yielded"; readonly path?: string }

export interface ComputerCommandDeps {
  readonly settings: ComputerSettings
  readonly runtimes: SessionRuntimes
  readonly preludeActive: (sessionID: string) => boolean
  readonly skill: () => ComputerSkillState | undefined
  readonly engine?: EngineLocatorOptions
}

function failureText(error: Error): string {
  const userFacing: unknown = Reflect.get(error, "userFacing")
  if (typeof userFacing !== "object" || userFacing === null) return error.message
  const message: unknown = Reflect.get(userFacing, "message")
  const action: unknown = Reflect.get(userFacing, "action")
  if (typeof message !== "string") return error.message
  return typeof action === "string" ? `${message} ${action}` : message
}

export async function runComputerSlashCommand(
  deps: ComputerCommandDeps,
  sessionID: string,
  args: string,
): Promise<{ readonly text: string; readonly level: MemoryCommandOutputLevel }> {
  const command = args.trim().toLowerCase() || "status"
  try {
    const runtime = await deps.runtimes.runtime(sessionID)
    const text = await runComputerCommand(args, runtime.handle, await deps.runtimes.context(sessionID))
    if (command !== "status") return { text, level: text === COMPUTER_COMMAND_USAGE ? "warning" : "info" }
    const source = describeInstalledEngine(resolveInstalledEngine(deps.settings.enginePath, deps.engine))
    const engineState = runtime.service.engineState
    const skill = deps.skill()
    const skillLine =
      skill?.kind === "yielded"
        ? `\nskill: your own ${COMPUTER_SKILL_NAME} skill is active in place of the built-in guide${skill.path === undefined ? "" : ` (${skill.path})`}`
        : ""
    const permissions = runtime.handle.running
      ? ""
      : `\n${await describeEnginePermissions(deps.settings.enginePath, deps.engine)}`
    const lines = [
      text,
      `engine: ${engineState}${engineState === "not started" ? ` (${source})` : ""}`,
      `prelude: ${deps.preludeActive(sessionID) ? "active" : "inactive"}${skillLine}`,
      `engine source: ${source}${permissions}`,
    ]
    return { text: lines.join("\n"), level: "info" }
  } catch (error) {
    if (!(error instanceof Error)) throw error
    return { text: `/computer ${args.trim()}: ${failureText(error)}`, level: "error" }
  }
}
