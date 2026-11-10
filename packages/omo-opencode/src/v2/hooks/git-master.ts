import type * as Plugin from "@opencode/plugin/promise/plugin"
import { resolveOmoGitMasterSettings } from "@oh-my-opencode/omo-config-core"
import { carriesAttributionDirective, resolveGitMasterSkillAdditions } from "@oh-my-opencode/skills-loader-core/opencode-skill-loader/native-git-master-skill-content"
import { loadRuntimeConfig } from "../config/runtime"

type Host = Pick<Plugin.Context, "tool" | "location" | "options">
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

/** Native git-master completed-read behavior; registration belongs to this receiving workspace. */
export async function registerGitMasterReadHook(host: Host): Promise<() => Promise<void>> {
  if (host.options?.["omo-senpi-git-master-attribution-disabled"] === true ||
      host.options?.["omo-senpi-disabled"] === true || process.env.OMO_SENPI_DISABLED === "1") return async () => {}
  let closed = false
  const registration = await host.tool.hook("execute.after", event => {
    if (closed || event.status !== "completed" || event.tool !== "read" || !isRecord(event.input)) return
    const path = event.input.file_path ?? event.input.path
    if (typeof path !== "string" || !path.replaceAll("\\", "/").endsWith("/git-master/SKILL.md")) return
    const settings = resolveOmoGitMasterSettings(loadRuntimeConfig({ cwd: host.location.directory }).config)
    const additions = resolveGitMasterSkillAdditions(settings)
    if (!additions) return
    const original = event.result.content
    if (typeof original === "string") {
      const rewritten = additions.rewriteSkillText(original)
      const content = additions.directive !== undefined && !carriesAttributionDirective([original])
        ? `${rewritten}\n\n${additions.directive}` : rewritten
      if (content !== original) event.result = { ...event.result, content }
      return
    }
    if (!Array.isArray(original)) return
    const firstTextIndex = original.findIndex(item => isRecord(item) && typeof item.text === "string")
    const texts = original.flatMap(item => isRecord(item) && typeof item.text === "string" ? [item.text] : [])
    const append = additions.directive !== undefined && !carriesAttributionDirective(texts)
    const content = original.map((item, index) => {
      if (index !== firstTextIndex || !isRecord(item) || typeof item.text !== "string") return item
      const text = additions.rewriteSkillText(item.text)
      return text === item.text ? item : { ...item, text }
    })
    if (append) content.push({ type: "text", text: additions.directive! })
    if (append || content.some((item, index) => item !== original[index])) event.result = { ...event.result, content }
  })
  let disposal: Promise<void> | undefined
  return () => {
    if (disposal) return disposal
    closed = true
    disposal = registration.dispose()
    return disposal
  }
}
