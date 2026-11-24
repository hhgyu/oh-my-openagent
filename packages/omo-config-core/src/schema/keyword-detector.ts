import * as z from "zod"

const KeywordTypeSchema = z.enum(["ultrawork", "team", "hyperplan", "hyperplan-ultrawork"])
export type KeywordType = z.infer<typeof KeywordTypeSchema>

/**
 * Prompt keywords that expand into a mode. `disabled_keywords` is a denylist and `enabled_expansions`
 * an allowlist (when set, only the listed types fire). OpenCode reads every type; OmO Native arms
 * only `ultrawork`, so it honors the `ultrawork` entries.
 */
export const OmoKeywordDetectorSettingsSchema = z
  .object({
    enabled_expansions: z.array(KeywordTypeSchema).optional(),
    disabled_keywords: z.array(KeywordTypeSchema).optional(),
  })
  .strict()

export type OmoKeywordDetectorSettings = z.infer<typeof OmoKeywordDetectorSettingsSchema>

export function isUltraworkKeywordEnabled(settings?: OmoKeywordDetectorSettings): boolean {
  return (
    !settings?.disabled_keywords?.includes("ultrawork") &&
    (settings?.enabled_expansions === undefined || settings.enabled_expansions.includes("ultrawork"))
  )
}
