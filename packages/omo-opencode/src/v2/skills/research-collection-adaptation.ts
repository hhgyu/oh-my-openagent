export const RESEARCH_COLLECTION_REFERENCE = "ulw-research/references/research-collection.md"

const NATIVE_MASS_PARAGRAPH_PREFIX =
  "**When the user asked for MASS research, the team is not the collection surface.**"
const SHARED_MASS_PARAGRAPH_PREFIX = "**When the user asked for MASS research, the wave is sized by the topic's angles"
const TEAM_ALONGSIDE =
  " Keep a small team alongside it for the debate rounds of Phase 3: attack is conversation, and background workers do not talk."

const QUESTION_TOOL_REPLACEMENTS: ReadonlyArray<readonly [string, string]> = [
  [
    "in one `ask_user_question` call with `waitForAnswer: false`,",
    "in one `question` call made after the collection workers have started (the pending prompt does not block them),",
  ],
  [
    "in the same `ask_user_question` call as the format questions, with `waitForAnswer: false`,",
    "in the same `question` call as the format questions,",
  ],
]

function lineStartingWith(lines: readonly string[], prefix: string, source: string): number {
  const index = lines.findIndex((line) => line.startsWith(prefix))
  if (index === -1) throw new Error(`${RESEARCH_COLLECTION_REFERENCE}: no line starts with the ${source} anchor`)
  return index
}

/**
 * OpenCode 2 stages no `mass-ulw` skill and has no `waitForAnswer` question tool, so the Native MASS-research paragraph
 * (which makes reading `mass-ulw` mandatory) is replaced by the shared paragraph, whose graph surface is conditional and
 * whose fallback is per-angle background workers, and the Native team stays alongside it. A drifted anchor fails the build.
 */
export function adaptResearchCollectionForV2(nativeText: string, sharedText: string): string {
  const shared = sharedText.split("\n")
  const sharedParagraph = shared[lineStartingWith(shared, SHARED_MASS_PARAGRAPH_PREFIX, "shared")]
  const native = nativeText.split("\n")
  native[lineStartingWith(native, NATIVE_MASS_PARAGRAPH_PREFIX, "Native")] = `${sharedParagraph}${TEAM_ALONGSIDE}`
  return QUESTION_TOOL_REPLACEMENTS.reduce((text, [from, to]) => {
    if (!text.includes(from))
      throw new Error(`${RESEARCH_COLLECTION_REFERENCE}: Native question wording drifted: ${from}`)
    return text.replace(from, to)
  }, native.join("\n"))
}
