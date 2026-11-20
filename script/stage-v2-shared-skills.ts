import { mkdir, readdir, readFile, rm, stat, writeFile } from "node:fs/promises"
import { join, resolve } from "node:path"
import { stageNativeSharedSkill, stageNativeSkill } from "../packages/omo-senpi/plugin/scripts/sync-skills.mjs"
import {
  NATIVE_SKILLS_DIRECTORY,
  SKILLS_OWNED_BY_COMPONENTS,
  stagingSourceFor,
} from "../packages/omo-opencode/src/v2/skills/shared-skills"
import { rewriteSkillForV2 } from "../packages/omo-opencode/src/v2/skills/staged-skill"

/**
 * Stages the shared skills the OpenCode 2 host registers (v2/skills/shared-skills.ts) next to the V2 chunks in dist/
 * (the root entry lazily loads V2) and dist/v2, in a directory of their own: dist/skills is the V1 mirror of the shared
 * pool and must keep its raw text. Each skill is the text the Senpi bundle ships (Native's own source for ulw-plan and
 * ulw-research, the Native adaptation of the shared skill for the rest, references/ and scripts/ intact; init-deep
 * takes the shared source because its Native override needs the dag SDK and mass-ulw, which V2 lacks),
 * then only the spellings OpenCode 2 differs on are rewritten (rewriteSkillForV2). ulw-execute is staged by
 * stage-v2-ulw-loop.ts for its own component.
 */
async function sharedSkillNames(repoRoot: string): Promise<string[]> {
  const root = join(repoRoot, "packages", "shared-skills", "skills")
  const names: string[] = []
  for (const entry of await readdir(root, { withFileTypes: true })) {
    if (!entry.isDirectory() || SKILLS_OWNED_BY_COMPONENTS.has(entry.name)) continue
    if ((await stat(join(root, entry.name, "SKILL.md")).catch(() => undefined))?.isFile()) names.push(entry.name)
  }
  return names.sort()
}

async function rewriteTree(target: string): Promise<void> {
  for (const entry of await readdir(target, { recursive: true, withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith(".md")) continue
    const path = join(entry.parentPath, entry.name)
    const text = await readFile(path, "utf8")
    const rewritten = rewriteSkillForV2(text)
    if (rewritten !== text) await writeFile(path, rewritten)
  }
}

async function stageV2SharedSkills(repoRoot: string): Promise<void> {
  const names = await sharedSkillNames(repoRoot)
  if (names.length === 0) throw new Error("no shared skills found to stage for the V2 host")
  for (const outputDir of [join(repoRoot, "dist"), join(repoRoot, "dist", "v2")]) {
    const staged = join(outputDir, NATIVE_SKILLS_DIRECTORY)
    await rm(staged, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
    await mkdir(staged, { recursive: true })
    for (const name of names) {
      const destination = join(staged, name)
      if (stagingSourceFor(name) === "shared") await stageNativeSharedSkill(name, destination)
      else await stageNativeSkill(name, destination)
      await rewriteTree(destination)
    }
  }
}

if (import.meta.main) await stageV2SharedSkills(resolve(import.meta.dir, ".."))
