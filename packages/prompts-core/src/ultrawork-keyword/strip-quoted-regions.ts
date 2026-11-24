const INJECTED_BLOCK = /<(omo-[a-z0-9-]+-(?:pointer|mode)|ultrawork-mode|omo-ultrawork-reminder)>[\s\S]*?<\/\1>/gi
const INLINE_CODE = /(?<!`)(`+)(?!`)[\s\S]*?(?<!`)\1(?!`)/g
// A message relayed from another session opens with a sender header: a bracketed tag such as `[REPORT]` or
// `[a -> b]`, or `Name (id), recipient:` / `Name (id) to recipient:`. Everything in it is someone else's text, so none of it is a request.
// The arrow form is a leading header naming one sender (optionally relayed "via" others) and any recipient list
// ("[lead via coordinator -> lane, PR#1]", "[lane -> coordinator + ledger-lane]"): a stricter `name -> name` shape let
// such relays arm sessions (#10822). A bracketed prose arrow ("[step 1 -> step 2]") names no sender and is not a header.
const RELAY_HEADER =
  /^\s*(?:\[(?:[A-Z][A-Z0-9_-]{2,}|[\w.:@#-]+(?: via [\w.:@#-]+)* -> [\w.:@#-]+[^\]\n]{0,160})\]|[A-Z][\w.-]{0,30} \([^()\s]{1,40}\)(?:, | to )[\w.-]{1,40}:)/
const BLOCK_QUOTE_LINE = /^ {0,3}>[^\n]*/gm
const DOUBLE_QUOTED = /"[^"\n]*"|\u201C[^\u201D\n]*\u201D/g
// A single-quoted span opens after a non-word character and closes before one, so the apostrophes in
// "don't" or "it's" never pair up; a quoted test or file name ('omo-senpi ultrawork ...') is a mention.
const SINGLE_QUOTED = /(?<![\w'])'[^'\n]{1,200}'(?![\w])|\u2018[^\u2019\n]{1,200}\u2019/g
const URL_SPAN = /(?<![a-z0-9+.-])[a-z][a-z0-9+.-]*:\/\/[^\s<>"'`]+/gi
// A skill named only to forbid it ("Do not load mass-ulw or ulw-research") is not a request: the
// negated verb's objects are masked up to the next sentence or clause break. A comma does not end
// the clause, so a comma-separated list of prohibitions stays masked; `but`, `then`, `instead`, `however` or a dash
// does, because what follows is the request ("Do not use tmux, but ulw the fix").

// Advice that forbids the mode without a "do not use" verb ("avoid ulw", "no ultrawork", "skip ulw-loop",
// "don't ulw this", a pasted rule list) is not a request either (#14389). Only the keyword list the prohibition
// names is masked: "ulw or mass-ulw", "ulw, ulw-loop and ultrawork". A comma that is not part of such a list ends it,
// so "No ulw-loop, just ulw this" and "avoid regressions, ulw the fix" still arm.
const PROHIBITED_ITEM = String.raw`(?:mass[- \t]?)?(?:ultrawork|ulw)(?:[-_](?:loop|plan|research|execute|mass))?\b`
const QUOTED_ITEM = new RegExp(`^${PROHIBITED_ITEM}$`, "i")
const LIST_ITEM = `(?:${PROHIBITED_ITEM}|\\x01+)`
const LIST_SEPARATOR = String.raw`(?:[ \t]*,[ \t]*(?:(?:or|and|nor)[ \t]+)?|[ \t]+(?:or|and|nor)[ \t]+|[ \t]*\/[ \t]*)`
// "ulw the fix" starts a request; "ultrawork for this task" still names the prohibited mode.
const PERIOD_NOUN = String.raw`(?:today|tonight|(?:time|moment|second|minute|hour|day|week|weekend|month|quarter|year|sprint|session|round|turn|run|iteration|cycle|phase|release|morning|afternoon|evening|night)s?)\b`
const DETERMINER = String.raw`(?:this|that|these|those|the|a|an|my|our|your|their|next|every|each|all)`
const UNITS = String.raw`(?:one|two|three|four|five|six|seven|eight|nine)`
const NUMBER_WORD = String.raw`(?:${UNITS}(?:[ \t]+hundred)?|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|(?:twenty|thirty|forty|fifty|sixty|seventy|eighty|ninety)(?:[- \t]${UNITS})?|hundred)`
const COUNT = String.raw`(?:\d+|${NUMBER_WORD}|a[ \t]+couple(?:[ \t]+of)?|(?:a[ \t]+)?few|an?|several|many|some)`
const PERIOD_ORDER = String.raw`(?:first|second|third|last|next|final|previous|past|coming)`
const PERIOD_PHRASE =
  String.raw`(?:(?:for|during|in|over|until|through|throughout)[ \t]+)?(?:${DETERMINER}[ \t]+)?` +
  String.raw`(?:(?:entire|whole|full|remaining|${PERIOD_ORDER}|rest[ \t]+of(?:[ \t]+the)?)[ \t]+)*(?:${COUNT}[ \t]+)?${PERIOD_NOUN}`
const TEMPORAL_ADVERB = String.raw`(?:for[ \t]+(?:now|today|a[ \t]+while)|today|tonight|now[ \t]+on|anymore|again|this[ \t]+once|at[ \t]+all)\b`
const DEMONSTRATIVE = String.raw`(?:this|that|these|those)\b`
const NOUN_PHRASE = String.raw`(?:${DETERMINER}[ \t]+(?:${COUNT}[ \t]+)?|${COUNT}[ \t]+)[a-z]`
const OBJECT = String.raw`(?:it|them|everything|all|something|anything|each|both|one|me|us|him|her|you)\b`
const REQUEST_MARKER = String.raw`(?:instead|just|but|then|rather|now)\b`
const KEYWORD_END = /(?:ultrawork|ulw)[ \t]+/iy
const LEADING_ADVERBS = /(?:(?:just|only|even|simply|all|completely|entirely)\b[ \t]+)+/iy
const SCOPE = /(?:for|during|in|on|within|at|until|through|throughout|over|from|before|after)\b/iy
const TEMPORAL = new RegExp(`(?:${TEMPORAL_ADVERB}|${PERIOD_PHRASE})`, "iy")
const REQUEST = new RegExp(`(?:${REQUEST_MARKER}|${OBJECT}|${DEMONSTRATIVE}|${NOUN_PHRASE})`, "iy")

function affirmativeAt(text: string, start: number): boolean {
  KEYWORD_END.lastIndex = start
  if (!KEYWORD_END.test(text)) return false
  LEADING_ADVERBS.lastIndex = KEYWORD_END.lastIndex
  const complement = LEADING_ADVERBS.test(text) ? LEADING_ADVERBS.lastIndex : KEYWORD_END.lastIndex
  SCOPE.lastIndex = TEMPORAL.lastIndex = REQUEST.lastIndex = complement
  if (SCOPE.test(text) || TEMPORAL.test(text)) return false
  return REQUEST.test(text)
}

const NEGATED_VERB = /\b(?:do\s+not|don['\u2019]t|dont|never)\s+(?:load|use|run|invoke|start|trigger|arm|enable)\b/gi
const CLAUSE_EDGE = new RegExp(String.raw`[.;:!?\n]|\s(?:but|then|instead|however)\b|\s[\u2014\u2013-]\s|,[ \t]*(?=(?:${REQUEST_MARKER}[ \t]+)?(?:ulw|ultrawork)\b)`, "gi")
const INTRODUCED_REQUEST = new RegExp(`${REQUEST_MARKER}[ \\t]+(?:ulw|ultrawork)\\b`, "iy")
const PROHIBITED_KEYWORD = new RegExp(
  String.raw`\b(?:avoid(?:ing)?|skip(?:ping)?|without|no|never|do[ \t]+not|don['\u2019]t|dont)[ \t]+(?:(?:using|use[ \t]+of|the)[ \t]+)?` +
    LIST_ITEM,
  "gi",
)
const SEPARATOR = new RegExp(LIST_SEPARATOR, "iy")
const ITEM = new RegExp(LIST_ITEM, "iy")

// A keyword glued to a preceding identifier segment (`mass-ulw`, `senpi-ulw-loop`, `.omo/ulw/`, `v1.ulw`)
// names something else; so does one that opens a path (`ulw-execute/ledger.jsonl`).
export const NOT_AFTER_IDENTIFIER = String.raw`(?<![A-Za-z0-9][-_.]|[/\\])`
export const NOT_BEFORE_PATH = String.raw`(?![-_.]?[A-Za-z0-9]*[/\\])`
// The keyword or skill name must end its own word: not continue into a longer identifier or file name
// (`ulw-plan-refactor`, `ulw-plan.md`). A chained skill word may follow if it, too, ends there
// (`mass ulw-loop`, `ulw-mass`), so `mass-ulw-loop-runner` is still an identifier.
const SEGMENT_END = String.raw`(?![-_.]?[A-Za-z0-9])`
export const NOT_INTO_IDENTIFIER = String.raw`(?![-_](?!(?:loop|plan|research|execute|mass)${SEGMENT_END})[A-Za-z0-9]|\.[A-Za-z0-9])`

// Preserve offsets for the ultrawork /skill: argument check. Non-whitespace masking also prevents
// a skill name from being fabricated across removed text, such as "ulw `not a request` loop".
function mask(region: string): string {
  return region.replace(/[^\r\n]/g, "\0")
}

export function stripQuotedSpans(text: string, retainListItems = false): string {
  if (RELAY_HEADER.test(text)) return mask(text)
  let visible = text.replace(INJECTED_BLOCK, mask)
  const fenceStart = /^ {0,3}(`{3,}|~{3,})[^\n]*(?:\n|$)/gm
  while (true) {
    const opening = fenceStart.exec(visible)
    if (opening === null) break
    const fence = opening[1]
    const fenceEnd = new RegExp(`^ {0,3}${fence[0]}{${fence.length},}[ \\t]*\\r?$`, "gm")
    fenceEnd.lastIndex = fenceStart.lastIndex
    const closing = fenceEnd.exec(visible)
    const end = closing === null ? visible.length : fenceEnd.lastIndex
    visible = visible.slice(0, opening.index) + mask(visible.slice(opening.index, end)) + visible.slice(end)
    fenceStart.lastIndex = end
  }
  const maskQuote = (quote: string) =>
    retainListItems && QUOTED_ITEM.test(quote.slice(1, -1)) ? "\x01".repeat(quote.length) : mask(quote)
  return visible
    .replace(INLINE_CODE, mask)
    .replace(BLOCK_QUOTE_LINE, mask)
    .replace(DOUBLE_QUOTED, maskQuote)
    .replace(SINGLE_QUOTED, maskQuote)
    .replace(URL_SPAN, mask)
}

export function maskNegatedInvocations(text: string): string {
  const verbsMasked = maskMatches(text, NEGATED_VERB, (start) => {
    CLAUSE_EDGE.lastIndex = start
    for (let edge; (edge = CLAUSE_EDGE.exec(text)) !== null;) {
      if (!edge[0].startsWith(",")) return edge.index
      INTRODUCED_REQUEST.lastIndex = CLAUSE_EDGE.lastIndex
      if (INTRODUCED_REQUEST.test(text) || affirmativeAt(text, CLAUSE_EDGE.lastIndex)) return edge.index
    }
    return text.length
  })
  return maskMatches(verbsMasked, PROHIBITED_KEYWORD, (end) => {
    for (;;) {
      SEPARATOR.lastIndex = end
      if (!SEPARATOR.test(verbsMasked) || affirmativeAt(verbsMasked, SEPARATOR.lastIndex)) return end
      ITEM.lastIndex = SEPARATOR.lastIndex
      if (!ITEM.test(verbsMasked)) return end
      end = ITEM.lastIndex
    }
  })
}

function maskMatches(text: string, prefix: RegExp, endOfMatch: (start: number) => number): string {
  const parts: string[] = []
  let cursor = 0
  prefix.lastIndex = 0
  for (let match; (match = prefix.exec(text)) !== null;) {
    const end = endOfMatch(prefix.lastIndex)
    parts.push(text.slice(cursor, match.index), mask(text.slice(match.index, end)))
    cursor = prefix.lastIndex = end
  }
  return parts.length ? parts.join("") + text.slice(cursor) : text
}

export function stripQuotedRegions(text: string): string {
  return maskNegatedInvocations(stripQuotedSpans(text, true)).replace(/\x01/g, "\0")
}
