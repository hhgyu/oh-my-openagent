import type { OmoComputerSettings } from "@oh-my-opencode/omo-config-core"
import {
  type ComputerSettings,
  type ComputerSettingsInput,
  isSupportedHost,
  resolveComputerSettings,
} from "@oh-my-opencode/senpi-desktop-tool/registration"
import { loadRuntimeConfig } from "../config/runtime"

/**
 * Copied from packages/omo-senpi/src/components/computer-use/settings.ts (the V2 boundary forbids importing
 * the Senpi adapter); settings.test.ts pins byte-for-byte parity of the mapping with the Senpi original.
 */
export function toComputerSettingsInput(block: OmoComputerSettings | undefined): ComputerSettingsInput | undefined {
  if (block === undefined) return undefined
  const input: Record<string, unknown> = {
    enabled: block.enabled,
    showCursor: block.showCursor,
    display: block.display,
    maxWidth: block.max_width,
    maxHeight: block.max_height,
    screenshotMaxBytes: block.screenshot_max_bytes,
    stopHotkey: block.stop_hotkey,
    allowHostRelayOnlyStop: block.allow_host_relay_only_stop,
    macosCanary: block.macos_canary,
    auditLog: block.audit_log === undefined ? undefined : { enabled: block.audit_log.enabled },
    screenshotGc:
      block.screenshot_gc === undefined
        ? undefined
        : {
            enabled: block.screenshot_gc.enabled,
            staleMs: block.screenshot_gc.stale_ms,
            scanIntervalMs: block.screenshot_gc.scan_interval_ms,
          },
    enginePath: block.engine_path,
    cuaAdapter: block.cua_adapter,
    runSandbox: block.run_sandbox,
    intervention: block.intervention,
    macosKeyPriming: block.macos_key_priming,
    trace: block.trace,
  }
  return JSON.parse(JSON.stringify(input)) as ComputerSettingsInput
}

export type ComputerUnavailableReason = "unsupported_host" | "disabled" | "invalid_settings"

export const COMPUTER_UNAVAILABLE_MESSAGE = {
  unsupported_host: "Computer use isn't supported on this system.",
  disabled: "Computer use is off. Set computer.enabled in omo.json, then restart OpenCode.",
  invalid_settings: "Computer use is off: its settings in omo.json are invalid. Fix them, then restart OpenCode.",
} as const satisfies Record<ComputerUnavailableReason, string>

export type ComputerAvailability =
  | { readonly settings: ComputerSettings; readonly disabledSkills: readonly string[] }
  | { readonly unavailable: ComputerUnavailableReason; readonly detail?: string }

export function loadComputerAvailability(cwd: string, platform: string = process.platform): ComputerAvailability {
  if (!isSupportedHost(platform)) return { unavailable: "unsupported_host" }
  try {
    const { config, diagnostics } = loadRuntimeConfig({ cwd })
    // The loader drops an invalid block with a diagnostic; computer use then stays off, as Native intends.
    const invalid = diagnostics.find(
      (diagnostic) =>
        "issuePaths" in diagnostic &&
        diagnostic.issuePaths?.some((path) => path === "computer" || path.startsWith("computer.")),
    )
    if (invalid !== undefined) return { unavailable: "invalid_settings", detail: invalid.message }
    const settings = resolveComputerSettings(toComputerSettingsInput(config.computer), platform)
    return settings.enabled ? { settings, disabledSkills: config.disabled_skills ?? [] } : { unavailable: "disabled" }
  } catch (error) {
    return { unavailable: "invalid_settings", detail: error instanceof Error ? error.message : String(error) }
  }
}
