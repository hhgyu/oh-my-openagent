import { afterAll, describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { toComputerSettingsInput as nativeToComputerSettingsInput } from "../../../../omo-senpi/src/components/computer-use/settings"
import { loadComputerAvailability, toComputerSettingsInput } from "./settings"

const root = mkdtempSync(join(tmpdir(), "omo-v2-computer-settings-"))
afterAll(() => rmSync(root, { recursive: true, force: true }))

function project(name: string, computer: unknown): string {
  const directory = join(root, name)
  mkdirSync(join(directory, ".omo"), { recursive: true })
  writeFileSync(join(directory, ".omo", "omo.json"), JSON.stringify({ computer }))
  return directory
}

describe("V2 computer settings", () => {
  test("#given every computer key #when mapped #then the V2 copy produces exactly the Native input", () => {
    // given
    const block = {
      enabled: true,
      showCursor: false,
      display: "all",
      max_width: 1280,
      max_height: 800,
      screenshot_max_bytes: 1000,
      stop_hotkey: "ctrl+alt+shift+escape",
      allow_host_relay_only_stop: true,
      macos_canary: "off" as const,
      audit_log: { enabled: false },
      screenshot_gc: { enabled: false, stale_ms: 1, scan_interval_ms: 2 },
      engine_path: "/opt/engine",
      cua_adapter: true,
      run_sandbox: "quickjs" as const,
      intervention: "pause" as const,
      macos_key_priming: "on" as const,
      trace: true,
    }

    // when
    const v2 = toComputerSettingsInput(block)

    // then
    expect(v2).toEqual(nativeToComputerSettingsInput(block))
    expect(toComputerSettingsInput(undefined)).toBeUndefined()
  })

  test("#given omo.json computer blocks #when availability is resolved #then it follows Native: settings, disabled, invalid, unsupported", () => {
    // given
    const enabled = project("enabled", { intervention: "pause", run_sandbox: "quickjs", cua_adapter: true })
    const disabled = project("disabled", { enabled: false })
    const invalid = project("invalid", { intervention: "sometimes" })

    // when
    const on = loadComputerAvailability(enabled, "win32")
    const off = loadComputerAvailability(disabled, "win32")
    const bad = loadComputerAvailability(invalid, "win32")
    const unsupported = loadComputerAvailability(enabled, "aix")

    // then
    if (!("settings" in on)) throw Error("expected settings")
    expect(on.settings).toMatchObject({ enabled: true, intervention: "pause", runSandbox: "quickjs", cuaAdapter: true })
    expect(off).toEqual({ unavailable: "disabled" })
    expect("unavailable" in bad && bad.unavailable).toBe("invalid_settings")
    expect(unsupported).toEqual({ unavailable: "unsupported_host" })
  })

  test("#given no computer block #when resolved on a supported host #then intervention defaults to continue and computer use is on", () => {
    // given
    const directory = project("default", {})

    // when
    const availability = loadComputerAvailability(directory, "win32")

    // then
    if (!("settings" in availability)) throw Error("expected settings")
    expect(availability.settings.enabled).toBe(true)
    expect(availability.settings.intervention).toBe("continue")
    expect(availability.settings.runSandbox).toBe("vm")
  })
})
