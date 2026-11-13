import { afterEach, beforeEach, describe, expect, it } from "bun:test"
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { loadOmoConfig } from "@oh-my-opencode/omo-config-core"

import { parseJsonc } from "../../shared/jsonc-parser"
import type { InstallConfig } from "../types"
import { resetConfigContext } from "./config-context"
import { generateOmoConfig } from "./generate-omo-config"
import { writeOmoConfig } from "./write-omo-config"

const installConfig: InstallConfig = {
  codexAutonomous: false,
  hasBailianCodingPlan: false,
  hasClaude: true,
  hasCodex: false,
  hasCopilot: false,
  hasGemini: true,
  hasKimiForCoding: false,
  hasMinimaxCnCodingPlan: false,
  hasMinimaxCodingPlan: false,
  hasOpenAI: true,
  hasOpenCode: true,
  hasOpencodeGo: false,
  hasOpencodeZen: false,
  hasSenpi: false,
  hasVercelAiGateway: false,
  hasZaiCodingPlan: false,
  isMax20: true,
  platform: "opencode",
}

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {}
}

describe("writeOmoConfig", () => {
  let homeDirectory = ""
  let originalHome: string | undefined

  beforeEach(() => {
    homeDirectory = join(tmpdir(), `omo-write-config-${Date.now()}-${Math.random().toString(36).slice(2)}`)
    originalHome = process.env.HOME
    mkdirSync(homeDirectory, { recursive: true })
    process.env.HOME = homeDirectory
    resetConfigContext()
  })

  afterEach(() => {
    rmSync(homeDirectory, { recursive: true, force: true })
    resetConfigContext()
    if (originalHome === undefined) delete process.env.HOME
    else process.env.HOME = originalHome
  })

  it("#given existing user settings #when writing install defaults #then user settings win within the unified block", () => {
    const path = join(homeDirectory, ".omo", "omo.jsonc")
    mkdirSync(join(path, ".."), { recursive: true })
    writeFileSync(
      path,
      JSON.stringify(
        {
          "[opencode]": {
            agents: { sisyphus: { model: "custom/provider-model" } },
            disabled_hooks: ["comment-checker"],
          },
        },
        null,
        2,
      ) + "\n",
    )

    const result = writeOmoConfig(installConfig)
    const document = parseJsonc<Record<string, unknown>>(readFileSync(path, "utf-8"))
    const config = record(document["[opencode]"])

    const sisyphus = record(record(config.agents).sisyphus)
    const primary = Array.isArray(sisyphus.models) ? sisyphus.models[0] : sisyphus.model
    expect(result).toEqual({ success: true, configPath: path })
    expect(typeof primary === "string" ? primary : record(primary).model).toBe("custom/provider-model")
    expect(config.disabled_hooks).toEqual(["comment-checker"])
    for (const key of Object.keys(generateOmoConfig(installConfig))) expect(config).toHaveProperty(key)
  })

  it("#given a multi-provider install #when the written block loads through the canonical opencode view #then every generated agent and category survives with its fallback chain and nothing is dropped", () => {
    const result = writeOmoConfig(installConfig)
    const generated = generateOmoConfig(installConfig)
    const loaded = loadOmoConfig({ cwd: homeDirectory, env: { HOME: homeDirectory }, harness: "opencode" })
    const sisyphus = record(record(generated.agents).sisyphus)
    const generatedChain = [
      sisyphus.model,
      ...(Array.isArray(sisyphus.fallback_models) ? sisyphus.fallback_models : []),
    ]

    expect(result.success).toBe(true)
    expect(generatedChain.length).toBeGreaterThan(1)
    expect(loaded.diagnostics).toEqual([])
    expect(Object.keys(loaded.config.agents ?? {}).sort()).toEqual(Object.keys(record(generated.agents)).sort())
    expect(Object.keys(loaded.config.categories ?? {}).sort()).toEqual(Object.keys(record(generated.categories)).sort())
    expect(
      (loaded.config.agents?.sisyphus?.models ?? []).map((entry) => (typeof entry === "string" ? entry : entry.model)),
    ).toEqual(generatedChain.map((entry) => (typeof entry === "string" ? entry : record(entry).model)))
  })

  it("#given no user config #when writing #then creates the user omo document", () => {
    const result = writeOmoConfig(installConfig)
    const path = join(homeDirectory, ".omo", "omo.jsonc")

    expect(result).toEqual({ success: true, configPath: path })
    expect(record(parseJsonc<Record<string, unknown>>(readFileSync(path, "utf-8"))["[opencode]"])).not.toEqual({})
  })
})
