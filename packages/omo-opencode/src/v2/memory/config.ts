import { homedir } from "node:os"
import { isAbsolute, relative, resolve, sep } from "node:path"
import { resolveMemoryRoot } from "@oh-my-opencode/memory-core"
import { OmoMemorySettingsSchema, type OmoMemoryRecall, type OmoMemorySettings } from "@oh-my-opencode/omo-config-core"
import type * as Plugin from "@opencode/plugin/promise/plugin"
import { loadRuntimeConfig } from "../config/runtime"

/** Plugin option that turns the whole memory component off regardless of `memory.enabled`. */
const MEMORY_ENABLED_OPTION = "omo-memory-enabled"

export type MemoryEnv = Readonly<Record<string, string | undefined>>

export interface MemoryLogger {
  warn(message: string, details?: Record<string, unknown>): void
  /** Informational records (repo maintenance); a logger without it drops them. */
  info?(message: string, details?: Record<string, unknown>): void
}

export const consoleMemoryLogger: MemoryLogger = {
  warn: (message, details) => console.warn(`[oh-my-openagent/v2] ${message}`, details ?? {}),
}

/** `memory` block of the unified config for one directory, schema defaults when absent. */
export function loadMemorySettings(cwd: string): OmoMemorySettings {
  return loadRuntimeConfig({ cwd }).config.memory ?? OmoMemorySettingsSchema.parse({})
}

/** Both gates must pass: the config flag and the plugin option (an explicit `false` disables). */
export function memoryComponentEnabled(settings: OmoMemorySettings, options: Plugin.Context["options"] | undefined): boolean {
  return settings.enabled && options?.[MEMORY_ENABLED_OPTION] !== false
}

/** Root recall block under the bound identity's per-agent override; `event_caps` merges per field. */
export function resolveRecallSettings(settings: OmoMemorySettings, identity: string): OmoMemoryRecall {
  const base = settings.recall
  const override = settings.agents[identity]?.recall
  return { ...base, ...override, event_caps: { ...base.event_caps, ...override?.event_caps } }
}

export type MemoryRootDecision =
  | { readonly ok: true; readonly root: string }
  | { readonly ok: false; readonly root: string; readonly reason: string }

/**
 * Resolves the memory root (`OMO_MEMORY_HOME` else `~/.omo/memory`) and refuses the OmO home itself and
 * anything under the desktop app's reserved entries (`~/.omo/desktop*`, including `desktop.init-*`).
 * Pure path arithmetic: nothing under `~/.omo` is listed or touched.
 */
export function resolveSafeMemoryRoot(env: MemoryEnv, cwd: string, home: string = homedir()): MemoryRootDecision {
  const root = resolveMemoryRoot({ ...env }, cwd)
  const omoHome = resolve(home, ".omo")
  const inside = relativeInside(omoHome, root)
  if (inside === "") return { ok: false, root, reason: "memory root is the OmO home (~/.omo)" }
  const first = inside?.split(sep)[0]
  if (first !== undefined && first.toLowerCase().startsWith("desktop")) {
    return { ok: false, root, reason: "memory root is inside the desktop app's reserved ~/.omo entries" }
  }
  return { ok: true, root }
}

/** `""` for the same path, the relative tail for a descendant, `undefined` otherwise. */
function relativeInside(parent: string, child: string): string | undefined {
  const caseFold = process.platform === "win32" || process.platform === "darwin"
  const a = caseFold ? resolve(parent).toLowerCase() : resolve(parent)
  const b = caseFold ? resolve(child).toLowerCase() : resolve(child)
  const tail = relative(a, b)
  if (tail === "") return ""
  if (tail.startsWith("..") || isAbsolute(tail)) return undefined
  return tail
}
