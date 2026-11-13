import { Skill } from "@opencode/plugin"
import type { Registration } from "@opencode/plugin/promise/registration"
import type { SkillDomain } from "@opencode/plugin/promise/skill"
import { parseFrontmatter } from "@oh-my-opencode/utils"
import { existsSync, readFileSync } from "node:fs"
import { join } from "node:path"

export const ULW_LOOP_SKILL_NAME = "ulw-loop"

const V2_TOOL_NAMES: ReadonlyArray<readonly [string, string]> = [["`todo`", "`todowrite`"]]

export function rewriteUlwLoopSkillForV2(text: string): string {
  return V2_TOOL_NAMES.reduce((current, [from, to]) => current.replaceAll(from, to), text)
}

/** script/stage-v2-ulw-loop.ts stages the Senpi skill next to the V2 chunks. */
export function locateUlwLoopSkillFile(directory: string = import.meta.dir): string | undefined {
  const file = join(directory, "skills", ULW_LOOP_SKILL_NAME, "SKILL.md")
  return existsSync(file) ? file : undefined
}

export function ulwLoopSkillInfo(file: string): Skill.Info {
  const { data, body } = parseFrontmatter<{ description?: unknown }>(readFileSync(file, "utf8"))
  return {
    id: Skill.ID.make(ULW_LOOP_SKILL_NAME),
    name: Skill.Name.make(ULW_LOOP_SKILL_NAME),
    ...(typeof data.description === "string" && { description: data.description }),
    path: Skill.Info.fields.path.make(file),
    content: rewriteUlwLoopSkillForV2(body),
  }
}

export async function registerUlwLoopSkill(
  skill: Pick<SkillDomain, "transform">,
  file: string | undefined,
): Promise<Registration | undefined> {
  if (file === undefined) {
    console.warn("[oh-my-openagent/v2] ulw-loop skill not staged next to this bundle; run the build")
    return undefined
  }
  const info = ulwLoopSkillInfo(file)
  return skill.transform((editor) => {
    if (editor.list().some((existing) => existing.name === ULW_LOOP_SKILL_NAME)) return
    editor.add(info)
  })
}
