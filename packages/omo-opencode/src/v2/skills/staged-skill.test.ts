import { afterEach, describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { registerStagedSkill } from "./staged-skill"

const ULW_LOOP_SKILL_NAME = "ulw-loop"

const roots: string[] = []
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function stagedSkill(): string {
  const root = mkdtempSync(join(tmpdir(), "v2-ulw-skill-"))
  roots.push(root)
  const file = join(root, "SKILL.md")
  writeFileSync(
    file,
    "---\nname: ulw-loop\ndescription: loop description\n---\n\nbody `todo` body, record `senpi:<session_id>`, end with `/goal clear`\n",
  )
  return file
}

function fakeSkillDomain(existing: { name: string }[] = []) {
  const catalog = [...existing] as Record<string, unknown>[]
  return {
    catalog,
    domain: {
      transform: async (callback: (editor: never) => void) => {
        callback({ list: () => catalog, add: (info: Record<string, unknown>) => catalog.push(info) } as never)
        return { dispose: async () => {} }
      },
    },
  }
}

describe("V2 staged skills", () => {
  test("#given the staged skill #when it registers #then OpenCode gets its frontmatter fields, its file path and the body with V2 tool names, session prefix and command names", async () => {
    // given
    const file = stagedSkill()
    const { catalog, domain } = fakeSkillDomain()

    // when
    await registerStagedSkill(domain, ULW_LOOP_SKILL_NAME, file)

    // then
    expect(catalog).toEqual([
      {
        id: ULW_LOOP_SKILL_NAME,
        name: ULW_LOOP_SKILL_NAME,
        description: "loop description",
        path: file,
        content: "\nbody `todowrite` body, record `opencode:<session_id>`, end with `/omo:goal clear`\n",
      },
    ])
  })

  test("#given the user's catalog already has a ulw-loop skill #when it registers #then the user's skill is kept", async () => {
    // given
    const { catalog, domain } = fakeSkillDomain([{ name: ULW_LOOP_SKILL_NAME }])

    // when
    await registerStagedSkill(domain, ULW_LOOP_SKILL_NAME, stagedSkill())

    // then
    expect(catalog).toEqual([{ name: ULW_LOOP_SKILL_NAME }])
  })
})
