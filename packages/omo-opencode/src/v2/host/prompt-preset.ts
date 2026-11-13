import type {
  BuildDynamicSystemPromptOptions,
  ModelWithPromptPresetMetadata,
  PromptPresetSettings,
  ResolvedPresetName,
  ResolvedPromptPreset,
} from "@code-yeongyu/senpi/prompt-presets"

export type PromptOptions = BuildDynamicSystemPromptOptions & {
  /** The 2026.11.12 runtime supports these fields, omitted by its public Pick type.
   * Keep the structural extension here and pin byte parity in tests. */
  readonly fullToolPrompt?: {
    readonly toolSnippets: Record<string, string>
    readonly promptGuidelines: string[]
  }
  /** A provider-native search tool is on the request even without the builtin `web_search` (senpi#2935). */
  readonly nativeSearchAvailable?: boolean
}

export type PromptRenderInput = {
  readonly model?: ModelWithPromptPresetMetadata
  readonly settings: PromptPresetSettings
  readonly options: PromptOptions
  readonly customPrompt?: string
  readonly appendSystemPrompt?: string
}

export type PromptRenderResult = {
  readonly prompt: string
  readonly preset?: ResolvedPresetName
  readonly source: "custom" | "preset" | "dynamic"
}

type PublicPresets = typeof import("@code-yeongyu/senpi/prompt-presets")
export interface PromptPresetPort {
  resolvePresetName: PublicPresets["resolvePresetName"]
  resolvePreset(
    model: ModelWithPromptPresetMetadata,
    settings: PromptPresetSettings,
    options: PromptOptions,
  ): ResolvedPromptPreset | undefined
  buildPreset(name: ResolvedPresetName, options: PromptOptions): ResolvedPromptPreset
  buildDynamicSystemPrompt(options: PromptOptions): string
  render(input: PromptRenderInput): PromptRenderResult
}

/** Pure public subpath only: no engine registration, settings/auth reads or role text. */
export async function createPromptPresetPort(): Promise<PromptPresetPort> {
  const presets = await import("@code-yeongyu/senpi/prompt-presets")
  return {
    resolvePresetName: presets.resolvePresetName,
    resolvePreset: presets.resolvePreset,
    buildPreset: presets.buildPreset,
    buildDynamicSystemPrompt: presets.buildDynamicSystemPrompt,
    render(input) {
      const append = input.appendSystemPrompt
      // Native base builder treats even an empty explicit prompt as a replacement.
      // The preset extension's guard uses Boolean(customPrompt), however: an
      // eligible model preset replaces an empty custom prompt. Preserve both.
      const preset =
        !input.customPrompt && input.model
          ? presets.resolvePreset(input.model, input.settings, input.options)
          : undefined
      if (preset)
        return { prompt: preset.prompt + (append ? `\n\n${append}` : ""), preset: preset.name, source: "preset" }
      if (input.customPrompt !== undefined) {
        return { prompt: input.customPrompt + (append === undefined ? "" : `\n\n${append}`), source: "custom" }
      }
      return {
        prompt: presets.buildDynamicSystemPrompt(input.options) + (append === undefined ? "" : `\n\n${append}`),
        source: "dynamic",
      }
    },
  }
}
