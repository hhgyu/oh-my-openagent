type Replacement = readonly [from: string, to: string]

const GATE_NOTE = "OmO's question gate keys on that header, so a dismissed or unanswered gate stays not approved"

const REPLACEMENTS: Readonly<Record<string, readonly Replacement[]>> = {
  "ulw-plan/SKILL.md": [
    [
      "with header `Approval` (`승인` in Korean), `required: true` and the wait flag true on that call**:",
      `with header \`Approval\` (\`승인\` in Korean) and no other gate field (${GATE_NOTE})**:`,
    ],
  ],
  "ulw-plan/references/full-workflow.md": [
    [
      "header `Approval` (`승인` in Korean) and `required: true` on the call, one question,",
      `header \`Approval\` (\`승인\` in Korean; ${GATE_NOTE}), one question,`,
    ],
  ],
  "ulw-plan/references/stance-calibration.md": [
    [
      "(`ask_user_question` or `request_user_input`, whichever this session lists) with its wait flag set to true, so it raises",
      "(`question`), so it raises",
    ],
    [
      "Set `required: true` on the call that asks the approval gate (header `Approval`, `승인` in Korean) and on the call that asks the final authorization block (header `Authorize`, `권한` in Korean).",
      `Give the call that asks the approval gate the header \`Approval\` (\`승인\` in Korean) and the call that asks the final authorization block the header \`Authorize\` (\`권한\` in Korean): the \`question\` tool has no required flag, and ${GATE_NOTE}.`,
    ],
    ["Leave ordinary forks unflagged:", "Give ordinary forks any other header:"],
  ],
  "ulw-research/references/research-delivery.md": [
    [
      "Ask with `waitForAnswer: false` and start collecting; unanswered fields run on the shown defaults",
      "Start the collection workers first, then ask with `question`: the pending prompt does not block workers already running, and unanswered fields run on the shown defaults",
    ],
  ],
}

export const QUESTION_ADAPTED_FILES: readonly string[] = Object.keys(REPLACEMENTS)

/**
 * OpenCode 2's `question` tool has no `required` or wait field (`Question.Prompt`), and OmO's question-gates hook arms
 * on the `Approval`/`Authorize` header (and their Korean forms) instead. The Native question-call fields are replaced
 * by that header rule; a drifted anchor throws so the build fails instead of shipping the Native call shape.
 */
export function adaptQuestionCallsForV2(file: string, text: string): string {
  const replacements = REPLACEMENTS[file]
  if (replacements === undefined) throw new Error(`${file}: no question-call adaptation is registered`)
  return replacements.reduce((current, [from, to]) => {
    if (!current.includes(from)) throw new Error(`${file}: question-call anchor drifted: ${from}`)
    return current.replace(from, () => to)
  }, text)
}
