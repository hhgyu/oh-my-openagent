// Bounds the model-supplied regular expression of `reflection_grep`. A JavaScript `RegExp` runs
// synchronously on the host's event loop and cannot be interrupted, so a catastrophic pattern would
// stall the whole OpenCode host. The guard therefore refuses, before compiling, the shapes that
// backtrack super-linearly, and the caller matches only a bounded prefix of each line under a wall
// clock budget checked between lines:
// - patterns longer than `REFLECTION_GREP_LIMITS.patternChars`;
// - a quantified group that itself contains a quantifier (`(a+)+`, `(\w*\s?)*`) or an alternation
//   (`(a|ab)*`): the classic exponential shapes;
// - backreferences (`\1`, `\k<name>`), which defeat every linear bound;
// - more than `unboundedQuantifiers` unbounded quantifiers (`*`, `+`, `{n,}`, `{n,m}` with m > 16),
//   which keeps polynomial backtracking (`.*.*.*.*x`) small on a bounded line.
// A refusal is a `ReflectionPathError("pattern_unsafe")`, so the model sees why and can simplify.

import { ReflectionPathError } from "./reflection-paths"

export const REFLECTION_GREP_LIMITS = {
  patternChars: 256,
  unboundedQuantifiers: 3,
  matchChars: 1_000,
  budgetMs: 2_000,
} as const

const LARGE_REPEAT = 16

interface GroupState {
  quantified: boolean
  alternation: boolean
}

function refuse(message: string): never {
  throw new ReflectionPathError(
    "pattern_unsafe",
    `${message}; simplify the pattern (literal text or a single quantifier per group)`,
  )
}

interface Quantifier {
  readonly length: number
  readonly upper: number
}

/** The quantifier starting at `index`, if any: its length and its upper repeat bound. */
function quantifierAt(pattern: string, index: number): Quantifier | undefined {
  const char = pattern[index]
  const lazy = pattern[index + 1] === "?" ? 2 : 1
  if (char === "*" || char === "+") return { length: lazy, upper: Number.POSITIVE_INFINITY }
  if (char === "?") return { length: lazy, upper: 1 }
  if (char !== "{") return undefined
  const match = /^\{(\d+)(,(\d*))?\}\??/.exec(pattern.slice(index))
  if (match === null) return undefined
  const upper =
    match[2] === undefined
      ? Number(match[1])
      : match[3] === "" || match[3] === undefined
        ? Number.POSITIVE_INFINITY
        : Number(match[3])
  return { length: match[0].length, upper }
}

/** `(?:`, `(?=`, `(?!`, `(?<=`, `(?<!` and `(?<name>` prefixes are group syntax, not quantifiers. */
const GROUP_PREFIX = /^\?(?::|=|!|<=|<!|<[A-Za-z_$][\w$]*>)/

export function assertSafeGrepPattern(pattern: string): void {
  if (pattern.length > REFLECTION_GREP_LIMITS.patternChars)
    refuse(`the pattern is longer than ${REFLECTION_GREP_LIMITS.patternChars} characters`)
  const stack: GroupState[] = [{ quantified: false, alternation: false }]
  let unbounded = 0
  let closedGroup: GroupState | undefined
  for (let index = 0; index < pattern.length; index += 1) {
    const char = pattern[index]
    const top = stack[stack.length - 1] ?? refuse("the pattern has unbalanced groups")
    const quantifier = quantifierAt(pattern, index)
    if (quantifier !== undefined) {
      // A group repeated at most once cannot backtrack across repetitions.
      if (closedGroup !== undefined && quantifier.upper > 1 && (closedGroup.quantified || closedGroup.alternation)) {
        refuse(
          closedGroup.quantified
            ? "a quantified group contains another quantifier"
            : "a quantified group contains an alternation",
        )
      }
      if (quantifier.upper > LARGE_REPEAT) unbounded += 1
      if (unbounded > REFLECTION_GREP_LIMITS.unboundedQuantifiers)
        refuse(`the pattern has more than ${REFLECTION_GREP_LIMITS.unboundedQuantifiers} unbounded quantifiers`)
      top.quantified = true
      closedGroup = undefined
      index += quantifier.length - 1
      continue
    }
    closedGroup = undefined
    if (char === "\\") {
      const next = pattern[index + 1] ?? ""
      if (/[1-9]/.test(next) || next === "k") refuse("backreferences are not supported")
      index += 1
    } else if (char === "[") {
      index += 1
      while (index < pattern.length && pattern[index] !== "]") index += pattern[index] === "\\" ? 2 : 1
    } else if (char === "(") {
      stack.push({ quantified: false, alternation: false })
      index += GROUP_PREFIX.exec(pattern.slice(index + 1))?.[0].length ?? 0
    } else if (char === ")") {
      const group = stack.pop()
      const parent = stack[stack.length - 1]
      if (group === undefined || parent === undefined) refuse("the pattern has unbalanced groups")
      parent.quantified ||= group.quantified
      parent.alternation ||= group.alternation
      closedGroup = group
    } else if (char === "|") {
      top.alternation = true
    }
  }
}
