// Copied from packages/omo-senpi/src/components/question-gates/gate-rule.ts (the V2 boundary forbids
// importing the Senpi adapter); question-gates.test.ts pins parity with the Senpi original.
// Contract with the skills (#9774): ulw-plan and mass-ulw give every gating question one of these exact
// headers. The anchored option-label rule is the fallback for a gate asked without the pinned header.
// Question text is never read. OpenCode 2's `question` tool uses the same `questions[].header` and
// `questions[].options[].label` shape, so the rule applies unchanged.
export const PINNED_GATE_HEADERS = ["Approval", "Authorize", "승인", "권한"] as const

export type GateRule = "header" | "label"

export interface GateMatch {
  readonly rule: GateRule
  readonly header: string | undefined
}

const GATE_HEADERS: ReadonlySet<string> = new Set([
  ...PINNED_GATE_HEADERS.map((header) => header.toLowerCase()),
  "authorise",
])
const GATE_LABEL = /^(?:approve|authori[sz]e)(?![a-z])/i

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function trimmedString(value: unknown): string | undefined {
  return typeof value === "string" ? value.trim() : undefined
}

function optionLabels(question: Record<string, unknown>): string[] {
  const options = question.options
  if (!Array.isArray(options)) return []
  return options.flatMap((option) => {
    const label = isRecord(option) ? trimmedString(option.label) : undefined
    return label === undefined ? [] : [label]
  })
}

export function matchGate(input: unknown): GateMatch | undefined {
  if (!isRecord(input)) return undefined
  const questions = input.questions
  if (!Array.isArray(questions)) return undefined
  const records = questions.filter(isRecord)
  for (const question of records) {
    const header = trimmedString(question.header)
    if (header !== undefined && GATE_HEADERS.has(header.toLowerCase())) return { rule: "header", header }
  }
  for (const question of records) {
    if (optionLabels(question).some((label) => GATE_LABEL.test(label))) {
      return { rule: "label", header: trimmedString(question.header) }
    }
  }
  return undefined
}
