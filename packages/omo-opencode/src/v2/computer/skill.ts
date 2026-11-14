import { createHash } from "node:crypto"
import { mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { COMPUTER_SKILL_NAME, computerSkillMarkdown } from "@oh-my-opencode/senpi-desktop-tool/registration"
import { rewriteCommandMentions } from "../commands/namespace"

export const COMPUTER_SKILL_ID = "oh-my-openagent/computer-use"

// Native finds the tool through tool_search; OpenCode 2 has none, so that one sentence names the V2 surfaces.
const NATIVE_DISCOVERY_SENTENCE =
  "Find the `computer` tool with `tool_search` (query `computer`). Once it is active, eval cells get the `computer` global in the next cell."
const V2_DISCOVERY_SENTENCE =
  "On OpenCode the `computer` tool is a Code Mode tool: call it through `execute` as `tools.computer({...})`. Eval cells have the `computer` global whenever computer use is on for the session."

export interface ComputerSkill {
  readonly id: string
  readonly name: string
  readonly description: string
  readonly path: string
  readonly content: string
}

function frontmatterField(markdown: string, field: string): string | undefined {
  const line = markdown.split("\n").find((entry) => entry.startsWith(`${field}: `))
  if (line === undefined) return undefined
  const value = line.slice(field.length + 2)
  return value.startsWith('"') ? (JSON.parse(value) as string) : value
}

export function buildComputerSkill(root: string = tmpdir()): ComputerSkill {
  const markdown = rewriteCommandMentions(
    computerSkillMarkdown().replace(NATIVE_DISCOVERY_SENTENCE, V2_DISCOVERY_SENTENCE),
  )
  const digest = createHash("sha256").update(markdown).digest("hex").slice(0, 16)
  const dir = join(root, `omo-v2-computer-skill-${digest}`, COMPUTER_SKILL_NAME)
  const path = join(dir, "SKILL.md")
  let current: string | undefined
  try {
    current = readFileSync(path, "utf8")
  } catch (error) {
    if (!(error instanceof Error && Reflect.get(error, "code") === "ENOENT")) throw error
  }
  if (current !== markdown) {
    mkdirSync(dir, { recursive: true })
    writeFileSync(path, markdown)
  }
  const body = markdown.replace(/^---\n[\s\S]*?\n---\n/, "")
  return {
    id: COMPUTER_SKILL_ID,
    name: COMPUTER_SKILL_NAME,
    description: frontmatterField(markdown, "description") ?? COMPUTER_SKILL_NAME,
    path,
    content: body,
  }
}
