const SKILL_COMMAND_PREFIX = "/skill:"
const EXPANDED_SKILL_TAG_PATTERN = /<skill\s+name="([^"]*)"[^>]*(?:>|$)|<\/skill>/gi
const SKILL_MD_PATH_PATTERN = /[\\/]skills[\\/]([^\\/]+)[\\/]SKILL\.md$/i
const PLAN_ARTIFACT_PATH_PATTERN = /(^|[\\/])\.omo[\\/]plans[\\/][^\\/]+\.md$/i
const PLAN_ARTIFACT_PATCH_PATTERN_GLOBAL = /\.omo[\\/]plans[\\/][^\s"'`]+\.md/gi
const INJECTED_TAG_PATTERN = /<(\/?)(ultrawork-mode|system-reminder)>/gi
const USER_REQUEST_PATTERNS: Readonly<Record<string, RegExp>> = { "ulw-plan": /\bulw[-_ ]?plan\b/i }
const OWN_WORDS_PLAN_REQUEST_PATTERNS: readonly RegExp[] = [
  /\b(?:make|write|create|draw|draft|build)\s+(?:me\s+)?(?:a|an|the)?\s*(?:work|implementation|action)?\s*plan\b/i,
  /\bplan\b[^.!?\n]{0,40}\bbefore\s+(?:you\s+)?(?:cod(?:e|ing)|implement|start|work)/i,
  /\bbefore\s+(?:you\s+)?(?:cod(?:e|ing)|implement|start)\b[^.!?\n]{0,40}\bplan\b/i,
  /\bplan\s+(?:it|this|that|the\s+work)\s+(?:out\s+)?first\b/i,
  /계획(?:서)?(?:부터|을|를|\s)*\s*(?:먼저\s*)?(?:세워|세우|짜|작성해|수립해)/,
  /(?:먼저|우선)\s*계획(?:서)?(?:을|를)?\s*(?:세워|세우|짜|작성해|수립해)/,
]

export interface SkillInputEvidence {
  readonly invoked: readonly string[]
  readonly requested: readonly string[]
}

function stripInjectedBlocks(text: string): string {
  const stack: string[] = []
  let cursor = 0,
    visible = ""
  for (const match of text.matchAll(INJECTED_TAG_PATTERN)) {
    const name = match[2]?.toLowerCase()
    if (name === undefined) continue
    if (match[1] === "") {
      if (!stack.length) visible += text.slice(cursor, match.index)
      stack.push(name)
    } else if (stack.at(-1) === name) {
      stack.pop()
      if (!stack.length) cursor = match.index + match[0].length
    }
  }
  return visible + (stack.length ? "" : text.slice(cursor))
}

/** Only call for human input. Skill documentation and injected blocks are not human requests. */
export function classifySkillInput(text: string): SkillInputEvidence {
  let visible = stripInjectedBlocks(text)
  const invoked = new Set<string>(),
    requested = new Set<string>()
  if (visible.startsWith(SKILL_COMMAND_PREFIX)) {
    const skill = visible.slice(SKILL_COMMAND_PREFIX.length).split(/\s/, 1)[0]?.trim()
    if (skill) {
      invoked.add(skill)
      requested.add(skill)
    }
  }
  let depth = 0,
    cursor = 0,
    ownWords = ""
  for (const match of visible.matchAll(EXPANDED_SKILL_TAG_PATTERN)) {
    if (match[1] !== undefined) {
      if (depth === 0) {
        ownWords += visible.slice(cursor, match.index)
        const skill = match[1].trim()
        if (skill) {
          invoked.add(skill)
          requested.add(skill)
        }
      }
      depth++
    } else if (depth > 0) {
      depth--
      if (depth === 0) cursor = match.index + match[0].length
    }
  }
  visible = ownWords + (depth === 0 ? visible.slice(cursor) : "")
  for (const [skill, pattern] of Object.entries(USER_REQUEST_PATTERNS)) if (pattern.test(visible)) requested.add(skill)
  if (OWN_WORDS_PLAN_REQUEST_PATTERNS.some((pattern) => pattern.test(visible))) requested.add("ulw-plan")
  return { invoked: [...invoked], requested: [...requested] }
}

export function skillNameFromPath(path: string | undefined): string | undefined {
  return path === undefined ? undefined : SKILL_MD_PATH_PATTERN.exec(path)?.[1]
}

export interface PlanArtifactToolResult {
  readonly toolName: string
  readonly path: string | undefined
  readonly patchText: string | undefined
}

/** Harness adapters call only after a successful tool result. Roots stay distinct. */
export function planArtifactPathsTouched(event: PlanArtifactToolResult): readonly string[] {
  const normalize = (path: string) => path.replace(/\\/g, "/")
  if (["read", "write", "edit"].includes(event.toolName)) {
    return event.path !== undefined && PLAN_ARTIFACT_PATH_PATTERN.test(event.path) ? [normalize(event.path)] : []
  }
  if (event.toolName !== "apply_patch" || event.patchText === undefined) return []
  return [...new Set((event.patchText.match(PLAN_ARTIFACT_PATCH_PATTERN_GLOBAL) ?? []).map(normalize))]
}
