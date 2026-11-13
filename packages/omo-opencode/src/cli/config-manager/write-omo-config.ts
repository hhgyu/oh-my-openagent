import { existsSync, readFileSync } from "node:fs"

import { resolveUserOmoConfigPath, updateOmoConfig } from "@oh-my-opencode/omo-config-core"

import { transformReasoningUnification } from "../../config-migration"
import { parseJsonc } from "../../shared"
import { runOpenCodeStartupMigration } from "../../startup-migration"
import type { ConfigMergeResult, InstallConfig } from "../types"
import { deepMergeRecord } from "./deep-merge-record"
import { formatErrorWithSuggestion } from "./format-error-with-suggestion"
import { generateOmoConfig } from "./generate-omo-config"

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {}
}

function existingOpenCodeConfig(path: string): Record<string, unknown> {
  if (!existsSync(path)) return {}
  const document = parseJsonc<Record<string, unknown>>(readFileSync(path, "utf-8"))
  return record(document["[opencode]"])
}

export function writeOmoConfig(installConfig: InstallConfig): ConfigMergeResult {
  const targetPath = resolveUserOmoConfigPath()
  let writtenPath = targetPath
  try {
    const migration = runOpenCodeStartupMigration({
      afterMigrations: () => {
        const generated = generateOmoConfig(installConfig)
        // The startup migration already ran (and recorded its marker), so the deprecated chain keys the
        // generator emits (`fallback_models`, `variant`) get the same one-shot rewrite here.
        const merged = record(
          transformReasoningUnification({
            "[opencode]": deepMergeRecord(generated, existingOpenCodeConfig(targetPath)),
          }).document["[opencode]"],
        )
        const result = updateOmoConfig({
          edits: [{ path: ["[opencode]"], value: merged }],
          scope: "user",
        })
        writtenPath = result.path
      },
      cwd: process.cwd(),
    })
    if (migration.error !== undefined) {
      return { success: false, configPath: targetPath, error: migration.error }
    }
    return { success: true, configPath: writtenPath }
  } catch (error) {
    return {
      success: false,
      configPath: writtenPath,
      error: formatErrorWithSuggestion(error, "write unified OMO config"),
    }
  }
}
