import type { Registration } from "@opencode/plugin/promise/registration"
import type { SkillDomain } from "@opencode/plugin/promise/skill"
import { existsSync, readdirSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { stagedSkillInfo } from "./staged-skill"

/** Next to the V2 chunks, apart from `skills/`, which is the raw shared tree the V1 plugin reads. */
export const NATIVE_SKILLS_DIRECTORY = "native-skills"

/** Skills a V2 component registers itself (with its own continuation); script/stage-v2-shared-skills.ts leaves them out. */
export const SKILLS_OWNED_BY_COMPONENTS: ReadonlySet<string> = new Set(["ulw-execute"])

/**
 * Skills whose Native (Senpi) override instructs a path OpenCode 2 cannot run, so the build stages the shared source
 * instead: init-deep's Native map wave needs the dag SDK (`OMO_DAG_SDK_ROOT`) and the Native-only `mass-ulw` skill, and
 * V2 binds only the agent-toolkit SDK and has no `mass-ulw`.
 */
const SKILLS_STAGED_FROM_SHARED_SOURCE: ReadonlySet<string> = new Set(["init-deep"])

export function stagingSourceFor(name: string): "shared" | "native" {
  return SKILLS_STAGED_FROM_SHARED_SOURCE.has(name) ? "shared" : "native"
}

export type StagedSkillFile = { readonly name: string; readonly file: string }

/** script/stage-v2-shared-skills.ts stages these next to the V2 chunks; a directory without SKILL.md is not a skill. */
export function locateSharedSkillFiles(directory: string = dirname(fileURLToPath(import.meta.url))): StagedSkillFile[] {
  const root = join(directory, NATIVE_SKILLS_DIRECTORY)
  if (!existsSync(root)) return []
  return readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && !SKILLS_OWNED_BY_COMPONENTS.has(entry.name))
    .map((entry) => ({ name: entry.name, file: join(root, entry.name, "SKILL.md") }))
    .filter(({ file }) => existsSync(file))
    .sort((left, right) => left.name.localeCompare(right.name))
}

/** One catalog edit adds every staged shared skill the catalog does not already have by name. */
export async function registerSharedSkills(
  skill: Pick<SkillDomain, "transform">,
  files: readonly StagedSkillFile[],
): Promise<Registration | undefined> {
  if (files.length === 0) {
    console.warn("[oh-my-openagent/v2] shared skills not staged next to this bundle; run the build")
    return undefined
  }
  const infos = files.map(({ name, file }) => stagedSkillInfo(name, file))
  return skill.transform((editor) => {
    const present = new Set(editor.list().flatMap((existing) => [existing.id, existing.name.toLowerCase()]))
    for (const info of infos) if (!present.has(info.id) && !present.has(info.name.toLowerCase())) editor.add(info)
  })
}
