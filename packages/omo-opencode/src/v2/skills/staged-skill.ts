import { Skill } from "@opencode/plugin"
import type { Registration } from "@opencode/plugin/promise/registration"
import type { SkillDomain } from "@opencode/plugin/promise/skill"
import { parseFrontmatter } from "@oh-my-opencode/utils"
import { existsSync, readFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

// The Native (omo-senpi) skill texts name Native tool spellings and the Senpi boulder session prefix; OpenCode 2 spells
// the todo tool `todowrite` and records its boulder sessions as `opencode:<id>`.
const V2_REWRITES: ReadonlyArray<readonly [RegExp, string]> = [
  [/`todo`/g, "`todowrite`"],
  [/senpi:(?=<session_id>|`)/g, "opencode:"],
]

export function rewriteSkillForV2(text: string): string {
  return V2_REWRITES.reduce((current, [pattern, replacement]) => current.replace(pattern, replacement), text)
}

/** script/stage-v2-ulw-loop.ts stages the skills next to the V2 chunks. */
export function locateStagedSkillFile(
  name: string,
  directory: string = dirname(fileURLToPath(import.meta.url)),
): string | undefined {
  const file = join(directory, "skills", name, "SKILL.md")
  return existsSync(file) ? file : undefined
}

function stagedSkillInfo(name: string, file: string): Skill.Info {
  const { data, body } = parseFrontmatter<{ description?: unknown }>(readFileSync(file, "utf8"))
  return {
    id: Skill.ID.make(name),
    name: Skill.Name.make(name),
    ...(typeof data.description === "string" && { description: data.description }),
    path: Skill.Info.fields.path.make(file),
    content: rewriteSkillForV2(body),
  }
}

export async function registerStagedSkill(
  skill: Pick<SkillDomain, "transform">,
  name: string,
  file: string | undefined,
): Promise<Registration | undefined> {
  if (file === undefined) {
    console.warn(`[oh-my-openagent/v2] ${name} skill not staged next to this bundle; run the build`)
    return undefined
  }
  const info = stagedSkillInfo(name, file)
  return skill.transform((editor) => {
    if (editor.list().some((existing) => existing.name === name)) return
    editor.add(info)
  })
}
