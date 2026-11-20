export interface ParsedArgument {
  readonly name: string
  readonly value: string
}

export interface ParsedEntries {
  readonly entries: readonly ParsedArgument[]
  readonly elided: boolean
}

export interface ParsedCall {
  readonly tool: string
  readonly line: number
  readonly raw: string
  readonly parsed: ParsedEntries | undefined
}

const OPENERS: Readonly<Record<string, string>> = { "(": ")", "[": "]", "{": "}" }
const CLOSERS: ReadonlySet<string> = new Set(Object.values(OPENERS))
const MAX_CALL_LENGTH = 6000
const NAMED = /^\s*["']?([A-Za-z_]\w*)["']?\s*[=:](?![=>])/
const BARE_NAME = /^\s*([A-Za-z_]\w*)\s*$/

function skipString(text: string, start: number): number {
  const quote = text[start]
  for (let index = start + 1; index < text.length; index++) {
    if (text[index] === "\\") index++
    else if (text[index] === quote) return index + 1
  }
  return -1
}

function skipPlaceholder(text: string, start: number): number {
  if (text[start] !== "<" || start === 0 || text[start + 1] === " " || text[start + 1] === "=") return start
  const before = text.slice(0, start).trimEnd().at(-1)
  if (before === undefined || !"=:,([".includes(before)) return start
  let depth = 0
  for (let index = start; index < text.length && index - start < 400; index++) {
    if (text[index] === "<") depth++
    else if (text[index] === ">" && --depth === 0) return index + 1
  }
  return start
}

function skipGroup(text: string, start: number): number {
  const stack: string[] = []
  for (let index = start; index < text.length && index - start < MAX_CALL_LENGTH; index++) {
    const char = text[index] as string
    if (char === "\\") index++
    else if (char === '"' || char === "'" || char === "`") {
      const end = skipString(text, index)
      if (end === -1) return -1
      index = end - 1
    } else if (char === "<") {
      const end = skipPlaceholder(text, index)
      if (end !== index) index = end - 1
    } else if (char in OPENERS) stack.push(OPENERS[char] as string)
    else if (CLOSERS.has(char)) {
      if (stack.pop() !== char) return -1
      if (stack.length === 0) return index
    }
  }
  return -1
}

function topLevelSegments(content: string): string[] | undefined {
  const segments: string[] = []
  let begin = 0
  for (let index = 0; index < content.length; index++) {
    const char = content[index] as string
    if (char === "\\") index++
    else if (char === '"' || char === "'" || char === "`") {
      const end = skipString(content, index)
      if (end === -1) return undefined
      index = end - 1
    } else if (char === "<") {
      const end = skipPlaceholder(content, index)
      if (end !== index) index = end - 1
    } else if (char in OPENERS) {
      const end = skipGroup(content, index)
      if (end === -1) return undefined
      index = end
    } else if (char === ",") {
      segments.push(content.slice(begin, index))
      begin = index + 1
    }
  }
  segments.push(content.slice(begin))
  return segments
}

export function parseEntries(content: string, objectForm: boolean): ParsedEntries | undefined {
  const segments = topLevelSegments(content)
  if (segments === undefined) return undefined
  const entries: ParsedArgument[] = []
  let elided = false
  for (const segment of segments) {
    const text = segment.trim()
    if (text === "") continue
    if (text.startsWith("...")) {
      elided = true
      continue
    }
    if (text.startsWith("{") && text.endsWith("}")) {
      const nested = parseEntries(text.slice(1, -1), true)
      if (nested === undefined) return undefined
      entries.push(...nested.entries)
      elided = elided || nested.elided
      continue
    }
    const named = NAMED.exec(text)
    if (named?.[1] !== undefined) entries.push({ name: named[1], value: text.slice(named[0].length).trim() })
    else if (objectForm && BARE_NAME.test(text)) entries.push({ name: text, value: "" })
  }
  return { entries, elided }
}

export function splitElements(content: string): string[] {
  return (topLevelSegments(content) ?? []).map((element) => element.trim()).filter((element) => element !== "")
}

export function findToolCalls(text: string, tools: readonly string[]): ParsedCall[] {
  const pattern = new RegExp(`(?<![\\w.$-])(${tools.join("|")})\\(`, "g")
  const calls: ParsedCall[] = []
  let match: RegExpExecArray | null
  while ((match = pattern.exec(text)) !== null) {
    const open = match.index + match[0].length - 1
    const close = skipGroup(text, open)
    const line = text.slice(0, match.index).split("\n").length
    if (close === -1) {
      calls.push({ tool: match[1] as string, line, raw: text.slice(open, open + 200), parsed: undefined })
      continue
    }
    const raw = text.slice(open + 1, close)
    calls.push({ tool: match[1] as string, line, raw, parsed: parseEntries(raw, false) })
    pattern.lastIndex = close + 1
  }
  return calls
}
