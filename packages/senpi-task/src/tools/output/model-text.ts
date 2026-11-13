import type { TaskSnapshot } from "./types"
import { normalizeRendererText } from "../../renderer-text"
import { excerptModelText as excerptRendererText } from "../../model-text"

// Model-facing model summary for the task_output status view text (TUI rows use formatStatusTarget).
// The effective route is what the child actually ran (#9722); when it differs from the plan the
// plan is shown alongside, never instead of it.
export function taskOutputModelText(snapshot: TaskSnapshot): string {
  const display = nonEmpty(snapshot.resolved_model?.display)
  const model = normalizeRendererText(snapshot.model)
  const reasoning = nonEmpty(snapshot.resolved_model?.reasoning) ?? nonEmpty(snapshot.resolved_model?.reasoning_effort)
  const variant = nonEmpty(snapshot.resolved_model?.variant)
  const details = [
    reasoning === undefined ? undefined : `reasoning ${reasoning}`,
    variant === undefined ? undefined : `variant ${variant}`,
  ].filter((part) => part !== undefined)
  const planned = `${display ?? model}${details.length > 0 ? ` (${details.join(", ")})` : ""}`
  const effective = nonEmpty(snapshot.effective_model?.display)
  const sameModel =
    snapshot.effective_model !== undefined &&
    snapshot.resolved_model !== undefined &&
    snapshot.effective_model.provider === snapshot.resolved_model.provider &&
    snapshot.effective_model.model_id === snapshot.resolved_model.model_id
  const operatorMark = snapshot.effective_model?.switched_by_operator === true ? " (switched by operator)" : ""
  return effective === undefined || sameModel
    ? `model ${planned}${operatorMark}`
    : `model ${effective}${operatorMark} (planned ${planned})`
}

function nonEmpty(value: string | undefined): string | undefined {
  const normalized = value === undefined ? undefined : excerptRendererText(value)
  return normalized !== undefined && normalized.length > 0 ? normalized : undefined
}
