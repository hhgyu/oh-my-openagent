// The keyword detector is the shared Core one Native Senpi also uses, so both hosts arm on
// exactly the same text (word boundaries, quoted/relayed/negated regions, identifiers).
import { classifyUltraworkInput, isUltraworkInput } from "@oh-my-opencode/prompts-core/ultrawork-keyword"

export type UltraworkPromptDecision = "arm" | "skip"

export interface UltraworkPromptInput {
  readonly text: string
  readonly skills?: ReadonlyArray<{ readonly id: string }>
}

const ULTRAWORK_SKILL_NAME = "ultrawork"

function attachesUltraworkSkill(skills: UltraworkPromptInput["skills"]): boolean {
  if (!skills) return false
  return skills.some((skill) => skill.id.split(/[/:]/).at(-1) === ULTRAWORK_SKILL_NAME)
}

/**
 * Decides whether a root-session user prompt arms ultrawork. Child-session suppression is
 * done by the caller from host session identity, so the classifier sees a root interactive
 * prompt. An attached `ultrawork` skill already carries the directive body into the
 * transcript, the same reason Senpi skips `/skill:ultrawork` expansion and pasted
 * `<ultrawork-mode>` blocks.
 */
export function classifyUltraworkPrompt(prompt: UltraworkPromptInput): UltraworkPromptDecision {
  if (attachesUltraworkSkill(prompt.skills)) return "skip"
  if (!isUltraworkInput(prompt.text)) return "skip"
  const classification = classifyUltraworkInput(
    { text: prompt.text, source: "interactive" },
    { wasArmed: false, compactRearmPending: false },
  )
  return classification.effective ? "arm" : "skip"
}
